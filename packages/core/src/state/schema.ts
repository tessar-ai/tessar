import type { Instruction } from "../instructions/instruction.js";
import type { JsonObject, JsonValue } from "../helpers/json.js";
import type { MessageData } from "../messages/message.js";
import type {
  ModelRef,
  ModelConnectionDescriptor,
} from "../models/contract.js";
import type {
  StreamRecord,
  TurnRecord,
  ModelAttemptRecord,
  ToolExecutionRecord,
} from "../trace/records.js";
export type Scope = Readonly<Record<string, string | number | boolean>>;
export interface PluginStateSnapshot {
  pluginId: string;
  namespace: string;
  ownerType: "thread" | "stream" | "turn" | "agent" | "session";
  ownerId: string;
  schemaVersion: number;
  revision: number;
  data: JsonValue;
}
export interface ThreadState {
  instructions: Instruction | null;
  scope: Scope;
  metadata: JsonObject;
  messages: readonly MessageData[];
  pluginStates: readonly PluginStateSnapshot[];
}
export const ExecutionPhase = {
  BeforeTurn: "BeforeTurn",
  BeforeModel: "BeforeModel",
  ModelPending: "ModelPending",
  BeforeTool: "BeforeTool",
  ToolPending: "ToolPending",
  TurnBoundary: "TurnBoundary",
  Suspended: "Suspended",
} as const;
export type ExecutionPhase =
  (typeof ExecutionPhase)[keyof typeof ExecutionPhase];
export interface StreamLimits {
  maxTurns: number;
  maxModelAttempts: number;
  maxToolCalls: number;
}
export interface StreamBudgetState {
  turns: number;
  modelAttempts: number;
  toolCalls: number;
  limits: StreamLimits;
}
export interface RegistrationRequirement {
  pluginId: string;
  kind: string;
  id: string;
  version: number;
  requiredForContinuation: boolean;
  pluginVersion?: number;
  configurationId?: string | null;
}
export interface HandlerCursor {
  eventId: string;
  handlerId: string;
  nextIndex: number;
  payload: JsonValue;
  decisions: readonly JsonValue[];
}
export interface ExecutionPosition {
  pendingSignals?: readonly MessageData[];
  timing?: {
    completedActiveMs: number;
    segmentOpen: boolean;
    complete: boolean;
  };
  streamId: string;
  turnId: string | null;
  phase: ExecutionPhase;
  modelRef: ModelRef;
  modelConnection?: ModelConnectionDescriptor;
  modelOptions?: JsonObject;
  baseInstructions: Instruction;
  pendingToolExecutionIds: readonly string[];
  pendingInterruptId: string | null;
  handlerCursor: HandlerCursor | null;
  budgets: StreamBudgetState;
  registryManifest: readonly RegistrationRequirement[];
}
export type CheckpointCause =
  | "ThreadCreated"
  | "InputCommitted"
  | "MessageCommitted"
  | "ExecutionTransition"
  | "PluginStateCommitted"
  | "Suspended"
  | "Resumed"
  | "Terminal"
  | "ForkCreated";
export interface Checkpoint {
  id: string;
  threadId: string;
  parentCheckpointId: string | null;
  revision: number;
  schemaVersion: 1;
  createdAt: string;
  state: ThreadState;
  execution: ExecutionPosition | null;
  cause: CheckpointCause;
}
export interface ThreadInfo {
  id: string;
  scope: Scope;
  metadata: JsonObject;
  revision: number;
  currentCheckpointId: string;
  activeStreamId: string | null;
  createdAt: string;
  updatedAt: string;
  parentThreadId: string | null;
  sourceCheckpointId: string | null;
  deleted: boolean;
}
export interface InterruptRecord {
  kind?: "decision" | "tool-result";
  id: string;
  threadId: string;
  streamId: string;
  checkpointId: string;
  definitionId: string;
  definitionVersion: number;
  pluginId: string;
  payload: JsonValue;
  responseSchema: JsonObject;
  actionRef: JsonObject | null;
  status: "pending" | "resolved" | "cancelled";
  response: JsonValue | null;
  resolvedDecision: JsonValue | null;
  createdAt: string;
  resolvedAt: string | null;
  revision: number;
}
export interface RecordTypes {
  streams: StreamRecord;
  turns: TurnRecord;
  model_attempts: ModelAttemptRecord;
  tool_executions: ToolExecutionRecord;
  interrupts: InterruptRecord;
}
export type RecordKind = keyof RecordTypes;
export type RecordEntry = {
  [K in RecordKind]: {
    kind: K;
    id: string;
    threadId: string;
    data: RecordTypes[K];
  };
}[RecordKind];
export interface PageOptions {
  cursor?: string;
  limit?: number;
}
export interface StateQuery {
  scope?: Scope;
}
export interface Page<T> {
  items: readonly T[];
  nextCursor: string | null;
}

export interface HistoryOptions extends PageOptions {
  atCheckpointId?: string;
}
export interface HistoryDataPage extends Page<MessageData> {
  checkpointId: string;
  revision: number;
}
export interface CheckpointInfo {
  id: string;
  threadId: string;
  revision: number;
  createdAt: string;
  cause: string;
  forkable: boolean;
  unsafeReason: string | null;
}
export interface RecordQuery extends PageOptions {
  streamId?: string;
  turnId?: string;
  status?: string;
  atCheckpointId?: string;
}
export interface StoredModelSelection {
  ref: ModelRef;
  options?: JsonObject;
  connection?: ModelConnectionDescriptor;
}
export interface SessionRecord {
  id: string;
  agentId: string;
  scope: Scope;
  metadata: JsonObject;
  selectedThreadId: string | null;
  selectedModel: StoredModelSelection;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
