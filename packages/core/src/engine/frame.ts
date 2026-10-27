import type { Agent } from "../agent.js";
import type { ExecutionRuntime } from "./runtime.js";
import { errorInfo, type ErrorInfo } from "../errors.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { MessageData } from "../messages/message.js";
import type { ModelAdapter, ModelRef } from "../models/contract.js";
import type { RegistryLease } from "../plugins/registry.js";
import {
  PluginStateAccess,
  type PluginStateDefinition,
} from "../state/plugin-state.js";
import type { Lease } from "../state/storage-ports.js";
import type { Checkpoint, RecordEntry, StreamLimits } from "../state/schema.js";
import type { StreamRecord } from "../trace/records.js";
import { stateTool } from "../runtime-state.js";
import type { LoopContext } from "../loop.js";
import type { Attachment } from "./delivery.js";
import type {
  SessionHookHandle,
  ThreadHookHandle,
} from "../plugins/context.js";

export type ExecutionRequest = (
  | {
      kind: "input";
      id?: string;
      threadId: string;
      input: readonly MessageData[];
      model: ModelRef;
      context?: JsonObject;
      limits?: Partial<StreamLimits>;
      initialSignal?: { persist: boolean };
    }
  | {
      kind: "resume";
      threadId: string;
      interruptId: string;
      value: JsonValue;
      model?: ModelRef;
    }
  | { kind: "recover"; threadId: string; streamId: string; model?: ModelRef }
) & {
  signal?: AbortSignal;
  adapter?: ModelAdapter;
  modelOptions?: JsonObject;
  session?: SessionHookHandle;
  thread?: ThreadHookHandle;
};

export interface ExecutionFrame {
  signals?: ReturnType<typeof import("./signal-delivery.js").findSignalTarget>;
  activeSegmentStartedAt?: number;
  turnStartedAt?: number;
  effectLocks?: Map<string, Promise<unknown>>;
  commitQueue?: Promise<void>;
  heartbeat?: ReturnType<typeof setInterval>;
  ownershipError?: ErrorInfo;
  request: ExecutionRequest;
  sink: Attachment;
  registry: RegistryLease;
  lease: Lease;
  cp: Checkpoint;
  stream: StreamRecord;
  records: Map<string, RecordEntry>;
  state: PluginStateAccess;
  admitted: boolean;
  sequence: number;
}

// Per-Agent bookkeeping and callbacks shared by execution functions.
export type ExecutionContext = Omit<LoopContext, "finish"> & {
  agent: Agent;
  runtime: ExecutionRuntime;
  active: Map<string, ExecutionFrame>;
  pendingModels: Map<string, ModelAdapter>;
  resumeAdmissions: Map<string, Promise<ExecutionFrame>>;
  prepareMessage(
    frame: ExecutionFrame,
    message: MessageData,
  ): Promise<MessageData>;
  finish(
    frame: ExecutionFrame,
    status: "completed" | "stopped" | "failed" | "cancelled",
    reason: string | null,
    error?: ErrorInfo | null,
  ): Promise<void>;
};

export async function loadRecords(
  execution: ExecutionContext,
  threadId: string,
): Promise<Map<string, RecordEntry>> {
  const records = new Map<string, RecordEntry>();
  for (const kind of [
    "streams",
    "turns",
    "model_attempts",
    "tool_executions",
    "interrupts",
  ] as const)
    for (const row of await execution.runtime.backend.executions.listRecords(
      kind,
      threadId,
    )) {
      const id = "id" in row ? row.id : "";
      records.set(kind + ":" + id, {
        kind,
        id,
        threadId,
        data: structuredClone(row),
      } as RecordEntry);
    }
  return records;
}

export function createFrame(
  execution: ExecutionContext,
  options: Pick<
    ExecutionFrame,
    | "request"
    | "sink"
    | "registry"
    | "lease"
    | "cp"
    | "stream"
    | "records"
    | "admitted"
  >,
): ExecutionFrame {
  if (options.request.adapter)
    execution.pendingModels.set(
      options.request.threadId,
      options.request.adapter,
    );
  else if (options.request.kind !== "input")
    options = {
      ...options,
      request: {
        ...options.request,
        adapter: execution.pendingModels.get(options.request.threadId),
      },
    };
  let frame!: ExecutionFrame;
  const state = new PluginStateAccess(
    options.registry.list<PluginStateDefinition<any>>("state"),
    { type: "thread", id: options.request.threadId },
    options.cp.state.pluginStates,
    async () => {
      await execution.commit(frame, "PluginStateCommitted");
      return frame.cp.id;
    },
    undefined,
    execution.runtime.backend.ownedState,
  );
  const timing = options.cp.execution?.timing;
  if (options.cp.execution)
    options.cp.execution.timing = {
      completedActiveMs: timing?.completedActiveMs ?? 0,
      complete: timing !== undefined && timing.complete && !timing.segmentOpen,
      segmentOpen: true,
    };
  frame = {
    ...options,
    state,
    sequence: 0,
    activeSegmentStartedAt: performance.now(),
  };
  const interruptId = options.cp.execution?.pendingInterruptId;
  options.sink.seedState({
    messages: options.cp.state.messages,
    status: options.stream.status,
    tools: [...options.records.values()].flatMap((record) =>
      record.kind === "tool_executions" &&
      record.data.streamId === options.stream.id
        ? [stateTool(record.data)]
        : [],
    ),
    interrupt: interruptId
      ? ((options.records.get("interrupts:" + interruptId)
          ?.data as import("../state/schema.js").InterruptRecord) ?? null)
      : null,
  });
  return frame;
}

export function watchLease(
  execution: ExecutionContext,
  frame: ExecutionFrame,
): void {
  if (frame.heartbeat) return;
  frame.heartbeat = setInterval(() => {
    void execution.runtime.backend.ownership.renew(frame.lease, 30000).then(
      (lease) => {
        frame.lease = lease;
      },
      (error) => {
        frame.ownershipError = errorInfo(error, {
          source: "storage",
          backendId: execution.runtime.backend.id,
        });
        frame.sink.controller.abort("OwnershipLost");
      },
    );
  }, 10000);
}

/** Account only observed attachment time; a crashed open segment is incomplete. */
export function sampleActiveTime(frame: ExecutionFrame, close = false): void {
  const timing = frame.cp.execution?.timing;
  if (!timing || frame.activeSegmentStartedAt === undefined) return;
  const now = performance.now();
  timing.completedActiveMs += Math.max(0, now - frame.activeSegmentStartedAt);
  timing.segmentOpen = !close;
  frame.activeSegmentStartedAt = close ? undefined : now;
}
