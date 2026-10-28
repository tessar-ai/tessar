import type { HookSpec, EventKind } from "./definition.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { MessageData } from "../messages/message.js";
import type {
  ModelRef,
  ModelRequest,
  ModelResponse,
  ProviderRequest,
  ToolDescription,
} from "../models/contract.js";
import type { ErrorInfo } from "../errors.js";
import type { ModelUsage, UsageSummary } from "../trace/usage.js";
import type { InterruptRecord, ThreadInfo } from "../state/schema.js";
import type { CreateThreadOptions } from "../state/threads.js";
import type { DecisionHookContext } from "../engine/interrupt.js";
import type { ExecutionHookContext } from "../engine/tracked-effects.js";
import type {
  SessionHookContext,
  ThreadHookContext,
} from "../plugins/context.js";
import type { ForkOptions } from "../state/fork.js";
import type { RuntimeState } from "../runtime-state.js";
export type OperationDecision = { decision: "allow" | "deny"; reason?: string };
export type OperationEvent =
  | "session.model.before-change"
  | "session.thread.before-switch"
  | "thread.before-fork"
  | "thread.before-rename"
  | "thread.before-delete";
export interface QueuedInputReceipt {
  id: string;
  threadId: string;
}
export interface ExecutionReceipt {
  streamId: string;
  threadId: string;
}
export type SuspendDecision = {
  decision: "suspend";
  definitionId: string;
  payload: JsonValue;
  pluginId: string;
  definitionVersion: number;
};
export type StreamDecision =
  | { decision: "allow" | "deny" | "stop"; reason?: string }
  | SuspendDecision;
export type ToolDecision = StreamDecision;
export type TurnDecision =
  | { decision: "allow" | "continue" | "deny" | "stop"; reason?: string }
  | SuspendDecision;
export type ModelSelectionDecision =
  | { decision: "allow" }
  | { decision: "select"; model: ModelRef }
  | SuspendDecision;
export type ModelRecoveryDecision =
  | { decision: "deny" | "retry"; reason?: string }
  | SuspendDecision;
export type ControlDecision =
  | StreamDecision
  | TurnDecision
  | ModelSelectionDecision
  | ModelRecoveryDecision;
export type ResolvedDecision = Exclude<ControlDecision, SuspendDecision>;
export interface InputPreparation {
  messages: readonly MessageData[];
  handled?: { output: readonly MessageData[] };
  rejected?: ErrorInfo;
}
export interface ToolPreparation {
  tool: ToolDescription;
  toolCallId: string;
  toolExecutionId: string;
  arguments: JsonObject;
}
export interface StreamOutcome {
  /** Logical Stream lifetime; suspension does not finish it. */
  startedAt?: string;
  endedAt?: string | null;
  status: string;
  reason: string | null;
  output: readonly MessageData[];
  usage: UsageSummary;
  error: ErrorInfo | null;
  interrupt: InterruptRecord | null;
}
export const ready = "ready";
export const shutdown = "shutdown";
export const diagnostic = "diagnostic";
export const stateChanged = "state_changed";
export const thread = {
  prepare: "thread.prepare",
  started: "thread.started",
  beforeFork: "thread.before-fork",
  forked: "thread.forked",
  beforeRename: "thread.before-rename",
  renamed: "thread.renamed",
  beforeDelete: "thread.before-delete",
  deleted: "thread.deleted",
} as const;
export const session = {
  created: "session.created",
  modelChanged: "session.model-changed",
  threadSwitched: "session.thread-switched",
  inputQueued: "session.input-queued",
  inputDiscarded: "session.input-discarded",
  closed: "session.closed",
  model: {
    beforeChange: "session.model.before-change",
    optionsChanged: "session.model.options-changed",
  },
  thread: {
    beforeSwitch: "session.thread.before-switch",
  },
} as const;
export const input = {
  prepare: "input.prepare",
  received: "input.received",
} as const;
export const stream = {
  before: "stream.before",
  started: "stream.started",
  end: "stream.end",
  error: "stream.error",
  suspended: "stream.suspended",
  resumed: "stream.resumed",
  cancel: "stream.cancel",
} as const;
export const turn = {
  start: "turn.start",
  end: "turn.end",
  decision: "turn.decision",
} as const;
export const context = {
  prepare: "context.prepare",
} as const;
export const model = {
  select: "model.select",
  start: "model.start",
  end: "model.end",
  response: "model.response",
  usage: "model.usage",
  error: "model.error",
  recover: "model.recover",
} as const;
export const provider = {
  request: "provider.request",
} as const;
export const message = {
  prepare: "message.prepare",
  committed: "message.committed",
} as const;
export const text = {
  start: "text.start",
  delta: "text.delta",
  end: "text.end",
} as const;
export const reasoning = {
  start: "reasoning.start",
  delta: "reasoning.delta",
  end: "reasoning.end",
} as const;
export const tool = {
  call: { start: "tool.call.start", end: "tool.call.end" },
  prepare: "tool.prepare",
  before: "tool.before",
  start: "tool.start",
  update: "tool.update",
  end: "tool.end",
  error: "tool.error",
  result: "tool.result",
} as const;
export const checkpoint = {
  committed: "checkpoint.committed",
} as const;
type Transform<P> = HookSpec<P, P, ExecutionHookContext>;
type Decision<P, D extends ControlDecision> = HookSpec<
  P,
  D,
  DecisionHookContext<D>
>;
type PartHooks = {
  [N in import("../models/contract.js").ModelPartChunk["type"]]: HookSpec<
    import("../models/contract.js").PartEvent<N>
  >;
};
declare module "./definition.js" {
  interface EventMap extends PartHooks {
    state_changed: HookSpec<{ state: RuntimeState }>;
    "session.model.before-change": HookSpec<
      {
        previous: ModelRef;
        model: ModelRef;
        previousOptions?: JsonObject;
        options?: JsonObject;
      },
      OperationDecision,
      SessionHookContext
    >;
    "session.thread.before-switch": HookSpec<
      { previousThreadId: string | null; threadId: string },
      OperationDecision,
      SessionHookContext
    >;
    "thread.before-fork": HookSpec<
      { threadId: string; options: ForkOptions },
      OperationDecision,
      ThreadHookContext
    >;
    "thread.before-rename": HookSpec<
      { threadId: string; title: string },
      OperationDecision,
      ThreadHookContext
    >;
    "thread.before-delete": HookSpec<
      { threadId: string; permanent?: boolean },
      OperationDecision,
      ThreadHookContext
    >;
    "thread.forked": HookSpec<
      { threadId: string; forkedThreadId: string },
      void,
      ThreadHookContext
    >;
    "thread.renamed": HookSpec<
      { threadId: string; title: string },
      void,
      ThreadHookContext
    >;
    "thread.deleted": HookSpec<
      { threadId: string; permanent?: boolean },
      void,
      ThreadHookContext
    >;
    "session.created": HookSpec<{ model: ModelRef }, void, SessionHookContext>;
    "session.model-changed": HookSpec<
      {
        previous: ModelRef;
        model: ModelRef;
        previousOptions?: JsonObject;
        options?: JsonObject;
      },
      void,
      SessionHookContext
    >;
    "session.model.options-changed": HookSpec<
      {
        model: ModelRef;
        previousOptions?: JsonObject;
        options?: JsonObject;
      },
      void,
      SessionHookContext
    >;
    "session.thread-switched": HookSpec<
      {
        previousThreadId: string | null;
        threadId: string;
      },
      void,
      SessionHookContext
    >;
    "session.input-queued": HookSpec<
      { receipt: QueuedInputReceipt },
      void,
      SessionHookContext
    >;
    "session.input-discarded": HookSpec<
      {
        receipt: QueuedInputReceipt;
        cause: string;
      },
      void,
      SessionHookContext
    >;
    "session.closed": HookSpec<{}, void, SessionHookContext>;
    diagnostic: HookSpec<{ error: ErrorInfo }>;
    ready: HookSpec<{ agentId: string }>;
    shutdown: HookSpec<{}>;
    "thread.prepare": HookSpec<CreateThreadOptions, CreateThreadOptions>;
    "thread.started": HookSpec<ThreadInfo>;
    "input.prepare": Transform<InputPreparation>;
    "input.received": HookSpec<{ messages: readonly MessageData[] }>;
    "stream.before": Decision<
      { input: readonly MessageData[] },
      StreamDecision
    >;
    "stream.started": HookSpec<{
      modelRef: ModelRef;
      checkpointId: string;
      startedAt?: string;
    }>;
    "stream.end": HookSpec<StreamOutcome>;
    "stream.error": HookSpec<{
      /** Consumer errors detach delivery without failing the execution. Defaults to execution. */
      target?: "execution" | "consumer";
      error: ErrorInfo;
      lastKnownCheckpointId: string | null;
      persistedStatus: string | null;
      startedAt?: string;
      endedAt?: string | null;
    }>;
    "stream.suspended": HookSpec<{
      checkpointId: string;
      interrupt: InterruptRecord;
    }>;
    "stream.resumed": HookSpec<{
      checkpointId: string;
      interruptId: string | null;
      reason: string;
    }>;
    "turn.start": HookSpec<
      {
        turnId: string;
        index: number;
        startedAt?: string;
      },
      void,
      import("../plugins/context.js").StateHookContext
    >;
    "turn.end": HookSpec<{
      turnId: string;
      usage: UsageSummary;
      startedAt?: string;
      endedAt?: string | null;
    }>;
    "turn.decision": Decision<
      { turnId: string; hadTools: boolean },
      TurnDecision
    >;
    "context.prepare": Transform<ModelRequest>;
    "model.select": Decision<{ model: ModelRef }, ModelSelectionDecision>;
    "provider.request": Transform<ProviderRequest>;
    "model.start": HookSpec<{
      attemptId: string;
      startedAt?: string;
      model: ModelRef;
      request?: ModelRequest;
      purpose?: "primary" | "auxiliary";
      turnId?: string;
      parentToolExecutionId?: string | null;
    }>;
    "model.end": HookSpec<{
      attemptId: string;
      response: ModelResponse;
      purpose?: "primary" | "auxiliary";
      startedAt?: string;
      endedAt?: string | null;
    }>;
    "model.response": Transform<ModelResponse>;
    "model.usage": HookSpec<{
      attemptId: string;
      usage: ModelUsage;
      purpose?: "primary" | "auxiliary";
    }>;
    "model.error": HookSpec<{
      attemptId: string;
      error: ErrorInfo;
      purpose?: "primary" | "auxiliary";
      startedAt?: string;
      endedAt?: string | null;
    }>;
    "model.recover": Decision<
      { attemptId: string; error: ErrorInfo },
      ModelRecoveryDecision
    >;
    "message.prepare": Transform<MessageData>;
    "message.committed": HookSpec<{
      message: MessageData;
      checkpointId: string;
    }>;
    "tool.prepare": Transform<ToolPreparation>;
    "tool.before": Decision<ToolPreparation, ToolDecision>;
    "tool.start": HookSpec<{
      toolExecutionId: string;
      startedAt?: string | null;
      toolCallId: string;
      turnId?: string;
      name?: string;
      arguments?: JsonObject;
    }>;
    "tool.update": HookSpec<{ toolExecutionId: string; progress: JsonValue }>;
    "tool.end": HookSpec<{
      toolExecutionId: string;
      toolCallId: string;
      result: MessageData;
      status: string;
      /** Execution times; notification may follow ordered result publication. */
      startedAt?: string | null;
      endedAt?: string | null;
    }>;
    "tool.error": HookSpec<{
      toolExecutionId: string;
      error: ErrorInfo;
      startedAt?: string | null;
      endedAt?: string | null;
    }>;
    "tool.result": Transform<MessageData>;
    "stream.cancel": HookSpec<{ reason: string }>;
    "checkpoint.committed": HookSpec<{
      checkpointId: string;
      revision: number;
    }>;
  }
}
/** Dispatch behavior is internal metadata; public event identifiers are strings. */
export const hookKinds: Readonly<Record<string, EventKind>> = Object.freeze({
  state_changed: "notification",
  ready: "notification",
  shutdown: "barrier",
  diagnostic: "notification",
  "thread.prepare": "transformation",
  "thread.started": "notification",
  "thread.before-fork": "decision",
  "thread.forked": "notification",
  "thread.before-rename": "decision",
  "thread.renamed": "notification",
  "thread.before-delete": "decision",
  "thread.deleted": "notification",
  "session.created": "notification",
  "session.model-changed": "notification",
  "session.model.options-changed": "notification",
  "session.thread-switched": "notification",
  "session.input-queued": "notification",
  "session.input-discarded": "notification",
  "session.closed": "notification",
  "session.model.before-change": "decision",
  "session.thread.before-switch": "decision",
  "input.prepare": "transformation",
  "input.received": "notification",
  "stream.before": "decision",
  "stream.started": "notification",
  "stream.end": "notification",
  "stream.error": "notification",
  "stream.suspended": "notification",
  "stream.resumed": "notification",
  "stream.cancel": "notification",
  "turn.start": "notification",
  "turn.end": "notification",
  "turn.decision": "decision",
  "context.prepare": "transformation",
  "model.select": "decision",
  "provider.request": "transformation",
  "model.start": "notification",
  "model.end": "notification",
  "model.response": "transformation",
  "model.usage": "notification",
  "model.error": "notification",
  "model.recover": "decision",
  "message.prepare": "transformation",
  "text.start": "notification",
  "text.delta": "notification",
  "text.end": "notification",
  "reasoning.start": "notification",
  "reasoning.delta": "notification",
  "reasoning.end": "notification",
  "tool.call.start": "notification",
  "tool.call.end": "notification",
  "message.committed": "notification",
  "tool.prepare": "transformation",
  "tool.before": "decision",
  "tool.start": "notification",
  "tool.update": "notification",
  "tool.end": "notification",
  "tool.error": "notification",
  "tool.result": "transformation",
  "checkpoint.committed": "notification",
});
export const ToolDecision = {
  allow: (): OperationDecision => ({ decision: "allow" }),
  deny: (reason: string): OperationDecision => ({ decision: "deny", reason }),
};
export const TurnDecision = {
  continue: (): { decision: "continue" } => ({ decision: "continue" }),
  stop: (reason: string): { decision: "stop"; reason: string } => ({
    decision: "stop",
    reason,
  }),
};
export const InputDecision = {
  continue: (messages: readonly MessageData[]): InputPreparation => ({
    messages,
  }),
  handled: (outcome: { output: readonly MessageData[] }): InputPreparation => ({
    messages: [],
    handled: outcome,
  }),
  reject: (error: ErrorInfo): InputPreparation => ({
    messages: [],
    rejected: error,
  }),
};
