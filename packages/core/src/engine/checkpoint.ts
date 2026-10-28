import {
  checkpoint as checkpointHooks,
  message as messageHooks,
  stream as streamHooks,
  turn as turnHooks,
} from "../events/type.js";
import { errorInfo, fail, type ErrorInfo } from "../errors.js";
import { immutable } from "../json.js";
import { type StreamOutcome } from "../events/type.js";
import { MessageCodec } from "../messages/codec.js";
import { ToolMessage, type MessageData } from "../messages/message.js";
import { CommitCoordinator } from "../state/commit.js";
import type {
  Checkpoint,
  CheckpointCause,
  RecordEntry,
} from "../state/schema.js";
import type {
  ModelAttemptRecord,
  ToolExecutionRecord,
  TurnRecord,
} from "../trace/records.js";
import { aggregateUsage } from "../trace/usage.js";
import {
  sampleActiveTime,
  type ExecutionContext,
  type ExecutionFrame,
} from "./frame.js";
import { closeSignals } from "./signal-delivery.js";

export function put(
  frame: ExecutionFrame,
  kind: RecordEntry["kind"],
  data: any,
): void {
  frame.records.set(kind + ":" + data.id, {
    kind,
    id: data.id,
    threadId: frame.cp.threadId,
    data,
  } as RecordEntry);
}

export function rows<T>(frame: ExecutionFrame, kind: RecordEntry["kind"]): T[] {
  return [...frame.records.values()]
    .filter((r) => r.kind === kind)
    .map((r) => r.data as T);
}

export async function updateUsage(
  execution: ExecutionContext,
  frame: ExecutionFrame,
): Promise<void> {
  const attempts = execution.rows<ModelAttemptRecord>(frame, "model_attempts");
  frame.stream.directUsage = aggregateUsage(
    attempts.filter((attempt) => attempt.streamId === frame.stream.id),
  );
  for (const turn of execution.rows<TurnRecord>(frame, "turns"))
    turn.usage = aggregateUsage(attempts.filter((a) => a.turnId === turn.id));
}

export async function commit(
  execution: ExecutionContext,
  frame: ExecutionFrame,
  cause: CheckpointCause,
  change?: () => void,
): Promise<void> {
  const queued = (frame.commitQueue ?? Promise.resolve()).then(() =>
    commitNow(execution, frame, cause, change),
  );
  frame.commitQueue = queued.catch(() => {});
  return queued;
}

async function commitNow(
  execution: ExecutionContext,
  frame: ExecutionFrame,
  cause: CheckpointCause,
  change?: () => void,
): Promise<void> {
  change?.();
  await execution.updateUsage(frame);
  sampleActiveTime(frame, cause === "Suspended");
  const cp: Checkpoint = {
    ...frame.cp,
    id: execution.ids.next("checkpoint"),
    parentCheckpointId: frame.cp.id,
    revision: frame.cp.revision + 1,
    createdAt: execution.clock.now(),
    cause,
    state: { ...frame.cp.state, pluginStates: frame.state.snapshots() },
    execution: frame.cp.execution ? { ...frame.cp.execution } : null,
  };
  if (cause === "Suspended" && cp.execution?.pendingInterruptId) {
    const record = frame.records.get(
      "interrupts:" + cp.execution.pendingInterruptId,
    )!;
    if (record.kind === "interrupts") {
      record.data.checkpointId = cp.id;
      record.data.revision = cp.revision;
    }
  }
  await new CommitCoordinator(execution.runtime.backend).commit(
    {
      commitId: execution.ids.next("commit"),
      threadId: cp.threadId,
      expectedRevision: frame.cp.revision,
      checkpoint: cp,
      records: [...frame.records.values()],
    },
    frame.lease,
  );
  frame.cp = { ...structuredClone(cp), execution: frame.cp.execution };
  await execution.hook(frame, checkpointHooks.committed, {
    checkpointId: cp.id,
    revision: cp.revision,
  });
}

export async function prepareMessage(
  execution: ExecutionContext,
  frame: ExecutionFrame,
  message: MessageData,
): Promise<MessageData> {
  const value = await execution.hook(
    frame,
    messageHooks.prepare,
    immutable(message),
  );
  if (
    value.id !== message.id ||
    value.role !== message.role ||
    value.toolCallId !== message.toolCallId
  )
    fail(
      "InvalidMessage",
      "Message transform changed identity/role/correlation",
    );
  const validated = MessageCodec.encode(MessageCodec.decode(value));
  return validated;
}

export async function appendMessage(
  execution: ExecutionContext,
  frame: ExecutionFrame,
  message: MessageData,
): Promise<void> {
  const value = await execution.prepareMessage(frame, message);
  frame.cp.state = {
    ...frame.cp.state,
    messages: [...frame.cp.state.messages, value],
  };
  if (value.role === "assistant" || value.role === "tool")
    frame.stream.outputMessageIds = [
      ...frame.stream.outputMessageIds,
      value.id,
    ];
  await execution.commit(frame, "MessageCommitted");
  await execution.hook(frame, messageHooks.committed, {
    message: value,
    checkpointId: frame.cp.id,
  });
}

export async function finish(
  execution: ExecutionContext,
  frame: ExecutionFrame,
  status: "completed" | "stopped" | "failed" | "cancelled",
  reason: string | null,
  error: ErrorInfo | null = null,
): Promise<void> {
  if (!(await closeSignals(frame, status === "completed"))) {
    frame.cp.execution!.phase = "BeforeTurn";
    return;
  }
  const pending = new Set<string>();
  for (const message of frame.cp.state.messages) {
    for (const part of message.content)
      if (part.type === "tool-call") pending.add(part.toolCallId);
    if (message.role === "tool") pending.delete(message.toolCallId!);
  }
  for (const toolCallId of pending) {
    const message = MessageCodec.encode(
      new ToolMessage("Execution " + status, { toolCallId }),
    );
    frame.cp.state = {
      ...frame.cp.state,
      messages: [...frame.cp.state.messages, message],
    };
    frame.stream.outputMessageIds = [
      ...frame.stream.outputMessageIds,
      message.id,
    ];
    const tool = execution
      .rows<ToolExecutionRecord>(frame, "tool_executions")
      .find(
        (t) => t.toolCallId === toolCallId && t.streamId === frame.stream.id,
      );
    if (tool && tool.status === "pending") {
      tool.status = "cancelled";
      tool.resultMessageId = message.id;
      tool.endedAt = execution.clock.now();
    }
  }
  frame.stream.status = status;
  frame.stream.stopReason = reason;
  frame.stream.error = error;
  frame.stream.endedAt = execution.clock.now();
  await execution.updateUsage(frame);
  const outcome: StreamOutcome = {
    startedAt: frame.stream.startedAt,
    endedAt: frame.stream.endedAt,
    status,
    reason,
    output: frame.cp.state.messages.filter((m) =>
      frame.stream.outputMessageIds.includes(m.id),
    ),
    usage: frame.stream.directUsage,
    error,
    interrupt: null,
  };
  const activeTurns = execution
    .rows<TurnRecord>(frame, "turns")
    .filter((turn) => turn.status === "running");
  for (const turn of activeTurns) {
    turn.status = status;
    turn.stopReason = reason;
    turn.error = error;
    turn.endedAt = execution.clock.now();
    turn.durationMs =
      frame.turnStartedAt === undefined
        ? null
        : Math.max(0, performance.now() - frame.turnStartedAt);
  }
  sampleActiveTime(frame, true);
  const timing = frame.cp.execution?.timing;
  frame.stream.durationMs = timing?.complete ? timing.completedActiveMs : null;
  frame.cp.execution = null;
  await execution.commit(frame, "Terminal");
  for (const turn of activeTurns)
    await execution.hook(frame, turnHooks.end, {
      turnId: turn.id,
      usage: turn.usage,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    });
  await execution.hook(frame, streamHooks.end, immutable(outcome));
}
