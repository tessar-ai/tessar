import { stream as streamHooks } from "../events/type.js";
import { fail } from "../errors.js";
import { immutable, type JsonValue } from "../json.js";
import {
  type ControlDecision,
  type ResolvedDecision,
  type SuspendDecision,
} from "../events/type.js";
import type {
  AnyEvent,
  EventContext,
  PayloadOf,
  ResultOf,
} from "../events/definition.js";
import { canonicalJson } from "../state/commit.js";
import type { ToolExecutionRecord } from "../trace/records.js";
import { Suspension, type InterruptionDefinition } from "./interrupt.js";
import { phaseForEvent } from "./resume.js";
import type { ExecutionContext, ExecutionFrame } from "./frame.js";

export function eventContext(
  execution: ExecutionContext,
  frame?: ExecutionFrame,
): EventContext {
  return {
    agentId: execution.agent.id,
    controllerId: execution.runtime.id,
    ...(frame
      ? {
          scope: frame.cp.state.scope,
          sessionId: frame.request.session?.id,
          streamId: frame.stream.id,
          threadId: frame.cp.threadId,
          sequence: ++frame.sequence,
          timestamp: execution.clock.now(),
        }
      : {}),
  };
}

export async function hook<D extends AnyEvent>(
  execution: ExecutionContext,
  frame: ExecutionFrame,
  definition: D,
  payload: PayloadOf<D>,
  toolExecutionId?: string,
): Promise<ResultOf<D>> {
  const cursor =
    frame.cp.execution?.handlerCursor?.eventId === definition
      ? frame.cp.execution.handlerCursor
      : null;
  const decisions: JsonValue[] = cursor?.decisions.slice() ?? [];
  // Transient initial input stays in memory, including decision continuation.
  if (
    cursor &&
    definition === streamHooks.before &&
    frame.signals?.transientInput
  )
    payload = { input: frame.signals.transientInput } as PayloadOf<D>;
  const kind = execution.runtime.hooks.kind(definition);
  const mutable = kind === "transformation" || kind === "decision";
  const context = {
    ...eventContext(execution, frame),
    ...(frame.request.session ? { session: frame.request.session } : {}),
    ...(frame.request.thread ? { thread: frame.request.thread } : {}),
    ...(definition === "turn.start" ? { state: frame.state } : {}),
    ...(mutable
      ? {
          ...execution.services(frame, toolExecutionId),
          state: frame.state,
        }
      : {}),
    signal: frame.sink.controller.signal,
    context: frame.request.kind === "input" ? frame.request.context : undefined,
    turnId: frame.cp.execution?.turnId,
    streamId: frame.stream.id,
    threadId: frame.cp.threadId,
    startIndex: cursor?.nextIndex ?? 0,
    initialDecision: decisions.at(-1) ?? undefined,
    allowedHandlerIds: frame.cp.execution?.registryManifest
      .filter((r) => r.kind === "handler")
      .map((r) => r.id),
    suspend:
      kind === "decision"
        ? <R, P extends JsonValue>(
            def: InterruptionDefinition<R, ResolvedDecision, P>,
            data: P,
          ): SuspendDecision => {
            phaseForEvent(definition);
            const binding = frame.registry.find<{
              definition: InterruptionDefinition;
              pluginId: string;
            }>("interruption", def.id);
            if (!binding || binding.definition.version !== def.version)
              fail(
                "ResumeIncompatible",
                "Interruption definition is not registered",
              );
            return {
              decision: "suspend",
              definitionId: def.id,
              definitionVersion: def.version,
              pluginId: binding.pluginId,
              payload: immutable(
                def.payload ? def.payload.parse(data) : data,
              ) as JsonValue,
            };
          }
        : undefined,
    onDecision:
      execution.runtime.hooks.kind(definition) === "decision"
        ? async (entry: {
            handlerId: string;
            index: number;
            decision: unknown;
          }) => {
            const value = entry.decision as ControlDecision | undefined;
            decisions.push(value ? (immutable(value) as JsonValue) : null);
            frame.cp.execution!.handlerCursor = {
              eventId: definition,
              handlerId: entry.handlerId,
              nextIndex: entry.index + 1,
              payload: immutable(
                definition === streamHooks.before &&
                  frame.signals?.transientInput
                  ? { input: [] }
                  : (cursor?.payload ?? payload),
              ) as JsonValue,
              decisions,
            };
            if (value?.decision !== "suspend")
              await execution.commit(frame, "ExecutionTransition");
          }
        : undefined,
  };
  const value = await execution.runtime.hooks.dispatch(
    definition,
    payload,
    context,
    frame.registry,
  );
  if (execution.runtime.hooks.kind(definition) === "decision") {
    if ((value as ControlDecision | undefined)?.decision === "suspend")
      await suspend(
        execution,
        frame,
        value as ControlDecision,
        toolExecutionId,
      );
    if (frame.cp.execution?.handlerCursor?.eventId === definition)
      frame.cp.execution.handlerCursor = null;
  }
  if (execution.runtime.hooks.kind(definition) === "notification")
    frame.sink.emit(definition, payload, context);
  return value;
}

async function suspend(
  execution: ExecutionContext,
  frame: ExecutionFrame,
  decision: ControlDecision,
  toolExecutionId?: string,
): Promise<never> {
  if (decision.decision !== "suspend")
    fail("InvalidTransition", "Expected suspension decision");
  const binding = frame.registry.find<{
    definition: InterruptionDefinition;
    pluginId: string;
  }>("interruption", decision.definitionId)!;
  const position = frame.cp.execution!,
    id = execution.ids.next("interrupt");
  const tool = toolExecutionId
    ? execution
        .rows<ToolExecutionRecord>(frame, "tool_executions")
        .find((t) => t.id === toolExecutionId)
    : null;
  const interrupt = {
    id,
    threadId: frame.cp.threadId,
    streamId: frame.stream.id,
    checkpointId: frame.cp.id,
    definitionId: decision.definitionId,
    definitionVersion: decision.definitionVersion,
    pluginId: decision.pluginId,
    payload: decision.payload,
    responseSchema: binding.definition.response.jsonSchema,
    actionRef: tool
      ? {
          toolExecutionId: tool.id,
          toolName: tool.toolName,
          argumentsDigest: canonicalJson(tool.arguments),
        }
      : null,
    status: "pending" as const,
    response: null,
    resolvedDecision: null,
    createdAt: execution.clock.now(),
    resolvedAt: null,
    revision: frame.cp.revision,
  };
  execution.put(frame, "interrupts", interrupt);
  position.pendingInterruptId = id;
  position.phase = "Suspended";
  frame.stream.status = "suspended";
  await execution.commit(frame, "Suspended");
  await execution.hook(frame, streamHooks.suspended, {
    checkpointId: frame.cp.id,
    interrupt,
  });
  throw new Suspension();
}
