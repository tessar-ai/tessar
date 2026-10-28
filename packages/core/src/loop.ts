import {
  turn as turnHooks,
  model as modelHooks,
  context as contextHooks,
  message as messageHooks,
} from "./events/type.js";
import type { ExecutionFrame } from "./engine/frame.js";
import { TessarError, errorInfo, fail } from "./errors.js";
import { immutable, type Clock, type IdGenerator } from "./json.js";

import type { AnyEvent, PayloadOf, ResultOf } from "./events/definition.js";
import type { MessageData } from "./messages/message.js";
import type { ModelResponse, ToolDescription } from "./models/contract.js";
import type { CheckpointCause, RecordEntry } from "./state/schema.js";
import {
  createModelAttempt,
  type ModelAttemptRecord,
  type ToolExecutionRecord,
  type TurnRecord,
} from "./trace/records.js";
import { aggregateUsage } from "./trace/usage.js";
import type { Tool } from "./tools/tool.js";
import { buildContext } from "./engine/context.js";
import { applySignals, signalMessages } from "./engine/signal-delivery.js";
import { callTools } from "./engine/tool-executor.js";
import {
  providerCall,
  bindExecutionModel,
  streamModel,
} from "./models/stream.js";
import { snapshotModelOptions } from "./models/options.js";
import { providerRequest } from "./engine/provider-request.js";
import { observeParts } from "./engine/model-parts.js";
import type { TrackedServices } from "./engine/tracked-effects.js";

export type LoopContext = {
  toolConcurrency: number;
  ids: IdGenerator;
  clock: Clock;
  hook<D extends AnyEvent>(
    frame: ExecutionFrame,
    definition: D,
    payload: PayloadOf<D>,
    toolExecutionId?: string,
  ): Promise<ResultOf<D>>;
  put(
    frame: ExecutionFrame,
    kind: RecordEntry["kind"],
    data: RecordEntry["data"],
  ): void;
  rows<T>(frame: ExecutionFrame, kind: RecordEntry["kind"]): T[];
  commit(
    frame: ExecutionFrame,
    cause: CheckpointCause,
    change?: () => void,
  ): Promise<void>;
  prepareMessage(
    frame: ExecutionFrame,
    message: MessageData,
  ): Promise<MessageData>;
  updateUsage(frame: ExecutionFrame): Promise<void>;
  appendMessage(frame: ExecutionFrame, message: MessageData): Promise<void>;
  services(frame: ExecutionFrame, toolExecutionId?: string): TrackedServices;
  finish(
    frame: ExecutionFrame,
    status: "completed" | "stopped",
    reason: string | null,
  ): Promise<void>;
};

// Shared by new input, resume and recovery; checkpoints retain the next phase.
export async function loop(
  frame: ExecutionFrame,
  context: LoopContext,
): Promise<void> {
  while (true) {
    if (frame.sink.controller.signal.aborted)
      throw new TessarError("Cancelled", "Execution cancelled");
    const position = frame.cp.execution!;
    if (position.phase === "BeforeTurn") {
      if (position.budgets.turns >= position.budgets.limits.maxTurns) {
        await context.finish(frame, "stopped", "MaxTurns");
        return;
      }
      frame.turnStartedAt = performance.now();
      const turn: TurnRecord = {
        id: context.ids.next("turn"),
        streamId: frame.stream.id,
        scope: frame.cp.state.scope,
        index: position.budgets.turns++,
        contextRevision: frame.cp.revision,
        assistantMessageId: null,
        status: "running",
        stopReason: null,
        startedAt: context.clock.now(),
        endedAt: null,
        durationMs: null,
        error: null,
        usage: aggregateUsage([]),
      };
      context.put(frame, "turns", turn);
      position.turnId = turn.id;
      position.phase = "BeforeModel";
      await context.commit(frame, "ExecutionTransition");
      await context.hook(frame, turnHooks.start, {
        turnId: turn.id,
        index: turn.index,
        startedAt: turn.startedAt,
      });
      continue;
    }
    if (position.phase === "BeforeModel") {
      if (!(await callModel(frame, context))) return;
      continue;
    }
    if (position.phase === "BeforeTool") {
      await callTools(frame, context);
      if (frame.stream.endedAt) return;
      continue;
    }
    if (position.phase === "TurnBoundary") {
      const turn = context
        .rows<TurnRecord>(frame, "turns")
        .find((t) => t.id === position.turnId)!;
      turn.status = "completed";
      turn.endedAt = context.clock.now();
      turn.durationMs =
        frame.turnStartedAt === undefined
          ? null
          : Math.max(0, performance.now() - frame.turnStartedAt);
      await context.updateUsage(frame);
      await context.commit(frame, "ExecutionTransition");
      await context.hook(frame, turnHooks.end, {
        turnId: turn.id,
        usage: turn.usage,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
      });
      const hadTools = !!frame.cp.state.messages
        .find((m) => m.id === turn.assistantMessageId)
        ?.content.some((p) => p.type === "tool-call");
      const decision = await context.hook(frame, turnHooks.decision, {
        turnId: turn.id,
        hadTools,
      });
      if (decision?.decision === "stop" || decision?.decision === "deny") {
        await context.finish(
          frame,
          "stopped",
          decision.reason ?? "PolicyStopped",
        );
        return;
      }
      if (!hadTools && decision?.decision !== "continue") {
        await context.finish(frame, "completed", null);
        if (frame.stream.endedAt) return;
      }
      position.phase = "BeforeTurn";
      await context.commit(frame, "ExecutionTransition");
      continue;
    }
    fail("RecoveryRequired", "Execution is at a pending operation boundary");
  }
}
async function callModel(
  frame: ExecutionFrame,
  context: LoopContext,
): Promise<boolean> {
  const position = frame.cp.execution!,
    budgets = position.budgets;
  if (budgets.modelAttempts >= budgets.limits.maxModelAttempts) {
    await context.finish(frame, "stopped", "MaxModelAttempts");
    return false;
  }
  const selection = await context.hook(frame, modelHooks.select, {
    model: position.modelRef,
  });
  const adapter = bindExecutionModel(
    frame.registry,
    position,
    frame.request.adapter,
    selection?.decision === "select" ? selection.model : undefined,
  );
  if (adapter.options || position.modelOptions)
    position.modelOptions = snapshotModelOptions({
      ...adapter.options,
      ...position.modelOptions,
    });
  const tools = frame.registry.list<Tool>("tool"),
    descriptions: ToolDescription[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.jsonSchema,
    }));
  await applySignals(frame, context);
  let request = buildContext(
    frame.cp,
    position.baseInstructions,
    descriptions,
    position.modelRef,
  );
  request = { ...request, messages: signalMessages(frame) };
  if (position.modelOptions)
    request = { ...request, options: position.modelOptions };
  request = await context.hook(frame, contextHooks.prepare, request);
  if (
    request.tools.some(
      (description) => !tools.some((tool) => tool.name === description.name),
    )
  )
    fail("UnknownTool", "Context includes an unregistered tool");
  if (
    request.model.providerId !== position.modelRef.providerId ||
    request.model.modelId !== position.modelRef.modelId ||
    request.model.connectionId !== position.modelRef.connectionId
  )
    fail(
      "ModelContextIncompatible",
      "Request transform must not bypass ModelSelect",
    );
  providerCall(position.modelRef, () => adapter.validate(request));
  const attempt = createModelAttempt(
    context,
    frame.cp,
    position.modelRef,
    "primary",
  );
  const priorAttempts = context
    .rows<ModelAttemptRecord>(frame, "model_attempts")
    .filter((a) => a.turnId === position.turnId && a.purpose === "primary");
  if (priorAttempts.length) {
    attempt.callId = priorAttempts[0]!.callId;
    attempt.attemptIndex = priorAttempts.length;
  }
  context.put(frame, "model_attempts", attempt);
  budgets.modelAttempts++;
  position.phase = "ModelPending";
  await context.commit(frame, "ExecutionTransition");
  await context.hook(frame, modelHooks.start, {
    attemptId: attempt.id,
    startedAt: attempt.startedAt,
    model: position.modelRef,
    request: immutable(request),
    purpose: attempt.purpose,
    turnId: attempt.turnId,
    parentToolExecutionId: attempt.parentToolExecutionId,
  });
  const attemptStartedAt = performance.now();
  let response: ModelResponse | undefined;
  try {
    for await (const chunk of streamModel(
      adapter,
      immutable(request),
      {
        signal: frame.sink.controller.signal,
        now: () => context.clock.now(),
        prepareRequest: providerRequest(context, frame, request.model, attempt),
      },
      observeParts(context, frame, attempt, attemptStartedAt),
    )) {
      if (chunk.type === "usage") {
        attempt.usage = chunk.usage;
        await context.hook(frame, modelHooks.usage, {
          attemptId: attempt.id,
          usage: chunk.usage,
          purpose: attempt.purpose,
        });
      }
      if (chunk.type === "response") response = chunk.response;
    }
    if (!response)
      fail("ProviderError", "Model stream ended without complete response");
    const attemptMessageId = response.message.id;
    response = await context.hook(frame, modelHooks.response, response);
    if (response.message.id !== attemptMessageId)
      fail(
        "InvalidMessage",
        "Model response transform changed message identity",
      );
    if (response.message.role !== "assistant")
      fail("InvalidMessage", "Model response must be assistant");
    attempt.usage = response.usage ?? attempt.usage;
    attempt.status = "succeeded";
    attempt.endedAt = context.clock.now();
    attempt.durationMs = Math.max(0, performance.now() - attemptStartedAt);
    attempt.finishReason = response.finishReason ?? null;
    attempt.providerRequestId = response.providerRequestId ?? null;
    attempt.responseMessageId = response.message.id;
    const turn = context
      .rows<TurnRecord>(frame, "turns")
      .find((t) => t.id === position.turnId)!;
    turn.assistantMessageId = response.message.id;
    const pending: ToolExecutionRecord[] = [];
    for (const part of response.message.content)
      if (part.type === "tool-call")
        pending.push({
          id: context.ids.next("tool"),
          turnId: turn.id,
          streamId: frame.stream.id,
          scope: frame.cp.state.scope,
          toolCallId: part.toolCallId,
          parentToolExecutionId: null,
          toolName: part.name,
          arguments: part.arguments,
          policyDecision: null,
          status: "pending",
          startedAt: null,
          endedAt: null,
          durationMs: null,
          resultMessageId: null,
          result: null,
          error: null,
          idempotencyKey: null,
        });
    for (const record of pending) context.put(frame, "tool_executions", record);
    frame.cp.execution!.pendingToolExecutionIds = pending.map((t) => t.id);
    frame.cp.execution!.phase = pending.length ? "BeforeTool" : "TurnBoundary";
    await context.appendMessage(frame, response.message);
    await context.hook(frame, modelHooks.end, {
      attemptId: attempt.id,
      response,
      purpose: attempt.purpose,
      startedAt: attempt.startedAt,
      endedAt: attempt.endedAt,
    });
    return true;
  } catch (error) {
    if (attempt.status === "succeeded") throw error;
    attempt.status = frame.sink.controller.signal.aborted
      ? "cancelled"
      : "failed";
    attempt.error = errorInfo(error);
    attempt.endedAt = context.clock.now();
    attempt.durationMs = Math.max(0, performance.now() - attemptStartedAt);
    await context.commit(frame, "ExecutionTransition");
    await context.hook(frame, modelHooks.error, {
      attemptId: attempt.id,
      error: attempt.error,
      purpose: attempt.purpose,
      startedAt: attempt.startedAt,
      endedAt: attempt.endedAt,
    });
    const recovery = await context.hook(frame, modelHooks.recover, {
      attemptId: attempt.id,
      error: attempt.error,
    });
    if (
      recovery?.decision === "retry" &&
      !frame.sink.controller.signal.aborted
    ) {
      frame.cp.execution!.phase = "BeforeModel";
      await context.commit(frame, "ExecutionTransition");
      return true;
    }
    throw error;
  }
}
