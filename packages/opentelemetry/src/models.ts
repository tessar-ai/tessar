import type { Span } from "@opentelemetry/api";
import {
  model,
  message,
  type ModelUsage,
  type PluginContext,
} from "@tessar/core";
import { time, update, type TraceRuntime } from "./trace.js";

/** Records model requests, retries, usage and time to first output. */
export function registerModelHooks(
  tessar: PluginContext,
  tracing: TraceRuntime,
): void {
  const { current, parentTurn, start, end, failure } = tracing;
  const capturedInstructions = new WeakSet<Span>();
  tessar.hook(model.start, (event) => {
    const state = current(event);
    if (!state || state.models.has(event.payload.attemptId)) return;
    const { attemptId, request, purpose, parentToolExecutionId, turnId } =
      event.payload;
    if (turnId && purpose !== "auxiliary") state.currentTurn = turnId;
    if (purpose !== "auxiliary" && request) {
      // Keep the first effective primary instructions for root display without
      // replacing the invocation input or letting later Turns overwrite it.
      if (!capturedInstructions.has(state.root)) {
        state.root.setAttribute(
          "tessar.instructions",
          JSON.stringify(request.instructions),
        );
        capturedInstructions.add(state.root);
      }
      update(parentTurn(state, event, turnId), "span", {
        input: request,
        metadata: { inputSource: "model.request" },
      });
    }
    const parent = parentToolExecutionId
      ? state.tools.get(parentToolExecutionId)
      : undefined;
    const span = start(
      event.payload.model.modelId,
      "generation",
      event,
      {
        ...state.identity,
        attemptId,
        purpose,
        parentToolExecutionId,
        turnId,
        providerId: event.payload.model.providerId,
        options: request?.options,
      },
      parent ??
        (purpose === "auxiliary" && state.currentTurn !== turnId
          ? state.root
          : parentTurn(state, event, turnId)),
      {
        model: event.payload.model.modelId,
        input: request,
        modelParameters: Object.fromEntries(
          Object.entries(request?.options ?? {}).filter(
            ([, value]) =>
              typeof value === "string" || typeof value === "number",
          ),
        ) as Record<string, string | number>,
      },
      event.payload.startedAt,
    );
    state.models.set(attemptId, span);
  });
  tessar.hook(message.delta, (event) => {
    const state = current(event),
      span = state?.models.get(event.payload.attemptId);
    if (!span || state!.firstOutputs.has(event.payload.attemptId)) return;
    state!.firstOutputs.add(event.payload.attemptId);
    update(span, "generation", {
      completionStartTime: time(event) ?? new Date(),
    });
  });
  const recordUsage = (span: Span, usage: ModelUsage) =>
    update(span, "generation", {
      usage,
      metadata: { usage },
    });
  tessar.hook(model.usage, (event) => {
    const span = current(event)?.models.get(event.payload.attemptId);
    if (span) recordUsage(span, event.payload.usage);
  });
  tessar.hook(model.end, (event) => {
    const state = current(event),
      span = state?.models.get(event.payload.attemptId);
    if (!span) return;
    const { response } = event.payload;
    if (response.usage) recordUsage(span, response.usage);
    update(span, "generation", {
      output: response.message,
      metadata: {
        finishReason: response.finishReason,
        providerRequestId: response.providerRequestId,
      },
    });
    if (event.payload.purpose !== "auxiliary")
      for (const part of response.message.content)
        if (part.type === "tool-call")
          state!.calls.set(part.toolCallId, {
            name: part.name,
            arguments: part.arguments,
          });
    end(span, event, event.payload.endedAt);
    state!.models.delete(event.payload.attemptId);
    state!.firstOutputs.delete(event.payload.attemptId);
  });
  tessar.hook(model.error, (event) => {
    const state = current(event),
      span = state?.models.get(event.payload.attemptId);
    if (!span) return;
    failure(span, "generation", event.payload.error);
    end(span, event, event.payload.endedAt);
    state!.models.delete(event.payload.attemptId);
    state!.firstOutputs.delete(event.payload.attemptId);
  });
}
