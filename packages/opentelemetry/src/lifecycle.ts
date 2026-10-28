import {
  input,
  stream,
  turn,
  message,
  checkpoint as checkpointHooks,
  type Checkpoint,
  type EventContext,
  type PluginContext,
} from "@tessar/core";
import { update, type TraceRuntime } from "./trace.js";
import type { ThreadTraceState } from "./types.js";

/** Persists Thread Turn counters and observes each execution segment. */
export function registerLifecycleHooks(
  tessar: PluginContext,
  tracing: TraceRuntime,
): void {
  const { executions, links, begin, current, parentTurn, end, finish } =
    tracing;
  const savedTrace = tessar.state.define<ThreadTraceState>({
    namespace: "trace",
    schemaVersion: 1,
    initial: {
      turnCount: 0,
      turnId: "",
    },
    fork: "reset",
  });
  tessar.hook(input.prepare, (event, context) => {
    if (!event.sessionId || !event.streamId) return;
    const saved = context.state.get(savedTrace);
    links.set(event.streamId, {
      turnCount: saved.turnCount,
      turnId: saved.turnId,
    });
  });
  tessar.hook(turn.start, async (event, context) => {
    if (!event.sessionId || !event.payload.turnId) return;
    const link = links.get(event.streamId!);
    if (!link) return;
    const saved = context.state.get(savedTrace),
      fresh = saved.turnId !== event.payload.turnId;
    const value = {
      turnId: event.payload.turnId,
      turnCount: saved.turnCount + (fresh ? 1 : 0),
    };
    context.state.update(savedTrace, value);
    Object.assign(link, value);
    await context.state.commit();
  });
  tessar.defer(async () => {
    for (const streamId of [...executions.keys()])
      finish({ streamId }, "interrupted");
    links.clear();
    await tracing.shutdown();
  });
  tessar.hook(stream.started, (event) => {
    begin(event, undefined, event.payload.startedAt);
  });
  const restore = (
    event: EventContext,
    checkpointId: string,
    checkpoint?: Checkpoint | null,
  ) => {
    const existing = current(event);
    if (existing) return existing;
    // Keep counters from old snapshots; root/Turn-created flags are obsolete.
    const snapshot = checkpoint?.state.pluginStates.find(
      (value) =>
        value.pluginId === "opentelemetry" &&
        value.namespace === "trace" &&
        value.ownerType === "thread",
    );
    if (event.sessionId && event.streamId && snapshot) {
      const saved = snapshot.data as unknown as ThreadTraceState;
      links.set(event.streamId, {
        turnCount: saved.turnCount,
        turnId: saved.turnId,
      });
    }
    const state = begin(event, checkpointId);
    if (!state) return;
    update(state.root, "agent", {
      input: { checkpointId },
      metadata: { inputSource: "resume" },
    });
    if (!checkpoint) return state;
    const execution = checkpoint.execution;
    if (!execution?.turnId || execution.phase === "BeforeTurn") return state;
    state.currentTurn = execution.turnId;
    const span = parentTurn(
      state,
      event,
      execution.turnId,
      execution.budgets.turns - 1,
    );
    update(span, "span", {
      input: { messages: checkpoint.state.messages },
      metadata: { inputSource: "checkpoint" },
    });
    for (const message of checkpoint.state.messages)
      for (const part of message.content)
        if (part.type === "tool-call")
          state.calls.set(part.toolCallId, {
            name: part.name,
            arguments: part.arguments,
          });
    return state;
  };
  tessar.hook(checkpointHooks.committed, async (event, context) => {
    // Recovery can publish saved tool results before stream.resumed. Open its
    // segment first; normal input.prepare has already installed its counter.
    if (!event.streamId || current(event) || links.has(event.streamId)) return;
    const checkpoint = await context.thread?.getCheckpoint(
      event.payload.checkpointId,
    );
    if (checkpoint?.execution) restore(event, checkpoint.id, checkpoint);
  });
  tessar.hook(stream.resumed, async (event, context) => {
    const checkpoint = await context.thread?.getCheckpoint(
      event.payload.checkpointId,
    );
    const state = restore(event, event.payload.checkpointId, checkpoint);
    if (state)
      update(state.root, "agent", {
        input: event.payload,
        metadata: { inputSource: "resume" },
      });
  });
  tessar.hook(input.received, (event) => {
    const state = current(event);
    if (!state) return;
    update(state.root, "agent", { input: event.payload.messages });
  });
  tessar.hook(turn.start, (event) => {
    const state = current(event);
    if (!state) return;
    state.currentTurn = event.payload.turnId;
    state.turnStartedAt = event.payload.startedAt ?? event.timestamp;
    // Thread numbering is updated at turn.start before a model is selected.
    if (!state.link)
      parentTurn(state, event, event.payload.turnId, event.payload.index);
  });
  tessar.hook(turn.end, (event) => {
    const state = current(event),
      turn = state?.turns.get(event.payload.turnId);
    if (!turn) return;
    update(turn.span, "span", {
      metadata: { usage: event.payload.usage, status: "ended" },
    });
    end(turn.span, event, event.payload.endedAt);
    state!.turns.delete(event.payload.turnId);
    if (state!.currentTurn === event.payload.turnId)
      state!.currentTurn = undefined;
  });
  tessar.hook(message.committed, (event) => {
    const state = current(event),
      value = event.payload.message;
    if (!state || (value.role !== "assistant" && value.role !== "tool")) return;
    state.output.push(value);
    const turn = state.currentTurn
      ? state.turns.get(state.currentTurn)
      : undefined;
    if (turn) {
      turn.output.push(value);
      update(turn.span, "span", { output: turn.output });
    }
  });
  tessar.hook(stream.suspended, (event) => {
    finish(event, "suspended");
  });
  tessar.hook(stream.end, (event) => {
    finish(
      event,
      event.payload.status,
      event.payload.error,
      event.payload.output,
      event.payload.endedAt,
    );
  });
  tessar.hook(stream.error, (event) => {
    if (event.payload.target === "consumer") return;
    begin(event);
    finish(
      event,
      "failed",
      event.payload.error,
      undefined,
      event.payload.endedAt,
    );
  });
}
