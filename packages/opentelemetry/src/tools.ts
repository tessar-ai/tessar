import { tool, type PluginContext, type Tool } from "@tessar/core";
import { update, type TraceRuntime } from "./trace.js";

/** Records tool arguments, results, errors and parent Turn relationships. */
export function registerToolHooks(
  tessar: PluginContext,
  tracing: TraceRuntime,
): void {
  const { current, parentTurn, start, end, failure } = tracing;
  tessar.hook(tool.start, (event, context) => {
    const state = current(event);
    if (!state || state.tools.has(event.payload.toolExecutionId)) return;
    const call = state.calls.get(event.payload.toolCallId);
    const name = event.payload.name ?? call?.name ?? "tool";
    const definition = context.registry.get<Tool>("tool", name);
    const span = start(
      name,
      "tool",
      event,
      {
        ...state.identity,
        toolExecutionId: event.payload.toolExecutionId,
        toolCallId: event.payload.toolCallId,
        toolDescription: definition?.description,
        toolParameters: definition?.jsonSchema,
      },
      parentTurn(state, event, event.payload.turnId),
      { input: event.payload.arguments ?? call?.arguments },
      event.payload.startedAt,
    );
    state.tools.set(event.payload.toolExecutionId, span);
  });
  tessar.hook(tool.error, (event) => {
    const span = current(event)?.tools.get(event.payload.toolExecutionId);
    if (span) failure(span, "tool", event.payload.error);
  });
  tessar.hook(tool.end, (event, context) => {
    const state = current(event);
    if (!state) return;
    const call = state.calls.get(event.payload.toolCallId);
    const definition = call && context.registry.get<Tool>("tool", call.name);
    const active = state.tools.get(event.payload.toolExecutionId);
    const span =
      active ??
      start(
        call?.name ?? "tool",
        "tool",
        event,
        {
          ...state.identity,
          toolExecutionId: event.payload.toolExecutionId,
          toolCallId: event.payload.toolCallId,
        },
        parentTurn(state, event),
        { input: call?.arguments },
      );
    update(span, "tool", {
      output: event.payload.result,
      metadata: {
        status: event.payload.status,
        toolDescription: definition?.description,
        toolParameters: definition?.jsonSchema,
      },
    });
    end(span, event, event.payload.endedAt);
    state.tools.delete(event.payload.toolExecutionId);
    state.calls.delete(event.payload.toolCallId);
  });
}
