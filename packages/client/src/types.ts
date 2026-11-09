import type {
  AgentInput, ModelRef, JsonObject, JsonValue, Scope, RuntimeState, EventContext,
  GenerateOutcome, SessionModelInfo, SessionRecord, ThreadInfo, StreamLimits,
  Instruction, Checkpoint, CheckpointInfo, HistoryDataPage, StreamRecord, TurnRecord,
  ModelAttemptRecord, ToolExecutionRecord, InterruptRecord, StoredRecord,
  QueuedInputReceipt, ExecutionReceipt, SendSignalOptions, UsageSummary,
  MessageData,
} from "./wire.js";
import type { RequestOptions } from "./transport.js";

/** JSON values returned by HTTP, never hydrated core instances. */
export type Serialized<T> = T extends Date ? string
  : T extends (...args: never[]) => unknown ? never
  : T extends readonly (infer U)[] ? readonly Serialized<U>[]
  : T extends object ? { [K in keyof T as T[K] extends (...args: never[]) => unknown ? never : K]: Serialized<T[K]> }
  : T;
export type Input = AgentInput;
export interface ExecutionOptions extends RequestOptions {
  model?: string | ModelRef;
  modelOptions?: JsonObject;
  scope?: Scope;
  context?: JsonObject;
  limits?: Partial<StreamLimits>;
  id?: string;
}
export interface SessionOptions extends RequestOptions {
  id?: string;
  scope?: Scope;
  model?: ModelRef;
  metadata?: JsonObject;
  threadId?: string;
}
export interface CreateThreadOptions extends RequestOptions {
  id?: string;
  title?: string;
  messages?: readonly MessageData[];
  metadata?: JsonObject;
}
export interface ThreadTarget extends RequestOptions { threadId: string }
export interface ForkOptions extends ThreadTarget {
  id?: string;
  atCheckpointId?: string;
  atMessageId?: string;
  metadata?: JsonObject;
}
export interface PageOptions extends RequestOptions { limit?: number; cursor?: string }
export interface ScopedPageOptions extends PageOptions { scope?: Scope }
export interface ExecutionListOptions extends PageOptions { status?: string }
export interface HistoryOptions extends PageOptions { atCheckpointId?: string }
export interface AbortOptions extends RequestOptions { reason?: string }
export interface ResumeInput { interruptId: string; value: JsonValue; model?: SessionOptions["model"] }
export interface RecoverInput { streamId: string; model?: SessionOptions["model"] }
export interface AgentResumeInput { threadId: string; interruptId: string; value: JsonValue; scope?: Scope }
export type SignalInput = SendSignalOptions;
export interface AppendRecordInput { namespace: string; id?: string; scope?: Scope; data: JsonValue }
export interface RecordsOptions extends ScopedPageOptions { namespace: string }
export interface Page<T> { items: readonly T[]; nextCursor: string | null }
export interface AgentInfo {
  id: string;
  controllerId?: string;
  model: ModelRef;
  instructions: Serialized<Instruction>;
  limits: StreamLimits;
}
export interface ControllerInfo { id: string; agentId: string; ready: boolean }
export interface SessionInfo {
  id: string; controllerId: string; agentId: string; scope: Scope; metadata: JsonObject;
  selectedThreadId: string | null; model: ModelInfo; idle: boolean; disposed: boolean;
}
export interface ThreadDescriptor { id: string; scope: Scope }
export interface ToolInfo { name: string; description: string; inputSchema: JsonObject }
export type ModelInfo = Serialized<SessionModelInfo> & { options?: JsonObject };
export type State = Serialized<RuntimeState>;
export type StateEvent = Serialized<EventContext> & { type: "state_changed"; timestamp: string; payload: { state: State } };
export type GenerateResult = Serialized<GenerateOutcome>;
export type SessionData = Serialized<SessionRecord>;
export type ThreadData = Serialized<ThreadInfo>;
export type CheckpointData = Serialized<Checkpoint>;
export type SnapshotData = CheckpointData & {
  activeStreamId: string | null;
  currentCheckpointId: string;
  usage: Serialized<UsageSummary>;
};
export type CheckpointSummary = Serialized<CheckpointInfo>;
export type HistoryPage = Serialized<HistoryDataPage>;
export type StreamData = Serialized<StreamRecord>;
export type TurnData = Serialized<TurnRecord>;
export type ModelAttemptData = Serialized<ModelAttemptRecord>;
export type ToolExecutionData = Serialized<ToolExecutionRecord>;
export type InterruptData = Serialized<InterruptRecord>;
export type RecordData = Serialized<StoredRecord>;
export type InputReceipt = Serialized<QueuedInputReceipt>;
export type ContinuationReceipt = Serialized<ExecutionReceipt>;
