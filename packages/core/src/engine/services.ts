import { model as modelHooks } from "../events/type.js";
import { errorInfo, fail } from "../errors.js";
import { immutable } from "../json.js";

import type {
  ModelChunk,
  ModelRef,
  ModelRequest,
  ModelResponse,
} from "../models/contract.js";
import { providerCall, selectAdapter, streamModel } from "../models/stream.js";
import { createModelAttempt } from "../trace/records.js";
import {
  EffectService,
  type EffectBinding,
  type TrackedServices,
} from "./tracked-effects.js";
import type { ExecutionContext, ExecutionFrame } from "./frame.js";

export function services(
  execution: ExecutionContext,
  frame: ExecutionFrame,
  toolExecutionId?: string,
): TrackedServices {
  const state = frame.state.withOwner({
    type: "stream",
    id: frame.stream.id,
  });
  frame.effectLocks ??= new Map();
  const effects = new EffectService(
    (id) => frame.registry.find<EffectBinding>("effect", id),
    state,
    () => execution.commit(frame, "PluginStateCommitted"),
    {
      signal: frame.sink.controller.signal,
      threadId: frame.cp.threadId,
      streamId: frame.stream.id,
      turnId: frame.cp.execution?.turnId ?? null,
      ...(toolExecutionId ? { toolExecutionId } : {}),
    },
    () => execution.ids.next("effect"),
    frame.effectLocks,
  );
  const guard = () => {
    if (!frame.admitted || !frame.cp.execution)
      fail(
        "UnsupportedBoundary",
        "Tracked execution requires admitted active work",
      );
  };
  return {
    models: {
      stream: (options) => {
        guard();
        return auxiliary(execution, frame, toolExecutionId, options);
      },
    },
    effects: {
      execute: (definition, input, options) => {
        guard();
        return effects.execute(definition, input, options);
      },
    },
    events: {
      emit: async (definition, payload) => {
        if (execution.runtime.hooks.kind(definition) !== "notification")
          fail("InvalidEvent", "Custom progress must be notification events");
        await execution.hook(frame, definition, payload, toolExecutionId);
      },
    },
  };
}

async function* auxiliary(
  execution: ExecutionContext,
  frame: ExecutionFrame,
  toolExecutionId: string | undefined,
  options: { model: ModelRef; request: ModelRequest; purpose: "auxiliary" },
): AsyncIterable<ModelChunk> {
  const position = frame.cp.execution!;
  if (!position.turnId)
    fail("UnsupportedBoundary", "Auxiliary calls require an active turn");
  const adapter = selectAdapter(
      frame.registry,
      options.model,
      frame.request.adapter,
    ),
    request = await execution.hook(
      frame,
      modelHooks.request,
      immutable(options.request),
      toolExecutionId,
    );
  // Reserve after awaited hooks so concurrent auxiliary calls cannot oversubscribe.
  if (
    position.budgets.modelAttempts >= position.budgets.limits.maxModelAttempts
  )
    fail("StreamLimit", "Model attempt budget exhausted");
  providerCall(options.model, () => adapter.validate(request));
  const attempt = createModelAttempt(
    execution,
    frame.cp,
    options.model,
    "auxiliary",
    toolExecutionId,
  );
  position.budgets.modelAttempts++;
  execution.put(frame, "model_attempts", attempt);
  await execution.commit(frame, "ExecutionTransition");
  const attemptStartedAt = performance.now();
  let response: ModelResponse | undefined;
  await execution.hook(
    frame,
    modelHooks.start,
    {
      attemptId: attempt.id,
      model: options.model,
      request: immutable(request),
      startedAt: attempt.startedAt,
      purpose: attempt.purpose,
      turnId: attempt.turnId,
      parentToolExecutionId: attempt.parentToolExecutionId,
    },
    toolExecutionId,
  );
  try {
    for await (const chunk of streamModel(adapter, request, {
      signal: frame.sink.controller.signal,
    })) {
      if (chunk.type === "message-delta" && attempt.firstOutputAt === null) {
        attempt.firstOutputAt = execution.clock.now();
        attempt.timeToFirstOutputMs = Math.max(
          0,
          performance.now() - attemptStartedAt,
        );
      }
      if (chunk.type === "usage") {
        attempt.usage = chunk.usage;
        await execution.hook(
          frame,
          modelHooks.usage,
          {
            attemptId: attempt.id,
            usage: chunk.usage,
            purpose: attempt.purpose,
          },
          toolExecutionId,
        );
      }
      if (chunk.type === "response") {
        attempt.usage = chunk.response.usage ?? attempt.usage;
        attempt.status = "succeeded";
        attempt.finishReason = chunk.response.finishReason ?? null;
        attempt.providerRequestId = chunk.response.providerRequestId ?? null;
        response = chunk.response;
      }
      yield chunk;
    }
  } catch (error) {
    attempt.status = "failed";
    attempt.error = errorInfo(error);
    attempt.endedAt = execution.clock.now();
    await execution.hook(
      frame,
      modelHooks.error,
      {
        attemptId: attempt.id,
        error: attempt.error,
        purpose: attempt.purpose,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
      },
      toolExecutionId,
    );
    throw error;
  } finally {
    if (attempt.status === "running") attempt.status = "interrupted";
    attempt.endedAt ??= execution.clock.now();
    attempt.durationMs = Math.max(0, performance.now() - attemptStartedAt);
    await execution.commit(frame, "ExecutionTransition");
    if (attempt.status === "succeeded" && response)
      await execution.hook(
        frame,
        modelHooks.end,
        {
          attemptId: attempt.id,
          response,
          purpose: attempt.purpose,
          startedAt: attempt.startedAt,
          endedAt: attempt.endedAt,
        },
        toolExecutionId,
      );
  }
}
