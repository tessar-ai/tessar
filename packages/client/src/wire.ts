// Client-owned JSON wire shapes. Compatibility is checked against core in tests only.

export type AgentInput = string | MessageData | readonly MessageData[];

export interface MessageData {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly role: MessageRole;
  readonly content: readonly ContentPart[];
  readonly metadata?: JsonObject;
  readonly providerState?: JsonValue;
  readonly toolCallId?: string;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type ContentPart = ({
  readonly type: "text";
  readonly text: string;
} | {
  readonly type: "reasoning";
  readonly text: string;
  readonly providerState?: JsonValue;
} | {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: JsonObject;
} | {
  readonly type: "image" | "audio" | "file";
  readonly mediaType: string;
  readonly data: string;
} | {
  readonly type: "data";
  readonly data: JsonValue;
}) & {
  readonly metadata?: JsonObject;
};

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
  readonly [key: string]: JsonValue;
};

export type JsonObject = {
  readonly [key: string]: JsonValue;
};

export interface ModelRef {
  providerId: string;
  modelId: string;
  /** Non-secret identity of a concrete connection, when supplied by an adapter. */
  connectionId?: string;
}

export type Scope = Readonly<Record<string, string | number | boolean>>;

export interface RuntimeState {
  readonly status: StreamStatus | "idle" | "closed";
  /** Committed messages and the current draft, in conversation order. */
  readonly messages: readonly RuntimeMessage[];
  readonly currentMessage: RuntimeDraft | null;
  readonly tools: readonly StateTool[];
  readonly interrupt: InterruptRecord | null;
  readonly queuedInputs: number;
  readonly error: ErrorInfo | null;
}

export type StreamStatus = "pending" | "running" | "suspended" | "interrupted" | "completed" | "stopped" | "failed" | "cancelled";

export type RuntimeMessage = Omit<MessageData, "content"> & {
  readonly content: readonly (ContentPart | RuntimePart)[];
};

export type RuntimePart = {
  readonly partId: string;
  readonly partIndex: number;
  readonly status: "streaming" | "completed" | "interrupted";
} & ({
  [K in "text" | "reasoning"]: {
    readonly type: K;
    readonly text: string;
  };
}["text" | "reasoning"] | {
  readonly type: "tool-call";
  readonly toolCallId?: string;
  readonly name?: string;
  readonly arguments?: JsonObject;
});

export type RuntimeDraft = Omit<MessageData, "content"> & {
  readonly content: readonly RuntimePart[];
};

export interface StateTool {
  readonly id: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly status: string;
  readonly progress: JsonValue | null;
  readonly result: MessageData | null;
  readonly error: ErrorInfo | null;
}

export interface ErrorInfo extends ErrorOrigin {
  name: string;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ErrorOrigin {
  source: "tessar" | "provider" | "plugin" | "tool" | "storage" | "application";
  providerId?: string;
  modelId?: string;
  pluginId?: string;
  eventId?: string;
  toolName?: string;
  backendId?: string;
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

export interface EventContext {
  controllerId?: string;
  agentId?: string;
  sessionId?: string;
  scope?: JsonObject;
  threadId?: string;
  streamId?: string | null;
  handleId?: string;
  sequence?: number;
  timestamp?: string;
  checkpointRevision?: number;
}

export interface GenerateOutcome {
  threadId: string;
  streamId: string;
  status: StreamRecord["status"];
  output: readonly MessageData[];
  usage: UsageSummary;
  interrupt: InterruptRecord | null;
  error: ErrorInfo | null;
}

export interface StreamRecord {
  outputMessageIds: readonly string[];
  id: string;
  threadId: string;
  scope: JsonObject;
  triggerMessageId: string | null;
  status: StreamStatus;
  stopReason: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  error: ErrorInfo | null;
  directUsage: UsageSummary;
}

export interface UsageSummary {
  metrics: Record<TokenMetric, UsageMetricSummary>;
}

export type TokenMetric = "inputTokens" | "uncachedInputTokens" | "outputTokens" | "reasoningOutputTokens" | "cacheReadInputTokens" | "cacheWriteInputTokens" | "totalTokens";

export interface UsageMetricSummary {
  knownTotal: number | null;
  knownAttempts: number;
  totalAttempts: number;
  coverage: "complete" | "partial" | "unavailable";
}

export interface SessionModelInfo {
  readonly id: string;
  readonly name: string;
  readonly profile: Readonly<ModelProfile>;
}

export interface ModelProfile extends ModelRef {
  name: string | null;
  contextWindow: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  capabilities: {
    tools: boolean | null;
    reasoning: boolean | null;
    structuredOutput: boolean | null;
    imageInput: boolean | null;
    audioInput: boolean | null;
    audioOutput: boolean | null;
  };
  pricing: ModelPricing | null;
  metadata: ProfileMetadata;
}

export interface ModelPricing {
  currency: string;
  basis: "million-tokens";
  type: "flat" | "tiered";
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  tiers?: readonly {
    condition: JsonValue;
    rates: JsonValue;
  }[];
}

export interface ProfileMetadata {
  completeness: "complete" | "partial" | "unavailable";
  freshness: "fresh" | "stale" | "unknown";
  fetchedAt: string | null;
  sourceRevision: string | null;
  provenance: Readonly<Record<string, string>>;
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

export interface StoredModelSelection {
  ref: ModelRef;
  options?: JsonObject;
  connection?: ModelConnectionDescriptor;
}

export interface ModelConnectionDescriptor {
  providerId: string;
  connectionId: string;
  protocol: string;
  endpoint: string;
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

export interface StreamLimits {
  maxTurns: number;
  maxModelAttempts: number;
  maxToolCalls: number;
}

export interface Instruction {
  readonly sections: readonly InstructionSection[];
}

export interface InstructionSection {
  readonly id: string;
  readonly content: string;
  /** Lower values come first; omitted values compare as zero. IDs break ties. */
  readonly order?: number;
}

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

export interface ThreadState {
  instructions: Instruction | null;
  scope: Scope;
  metadata: JsonObject;
  messages: readonly MessageData[];
  pluginStates: readonly PluginStateSnapshot[];
}

export interface PluginStateSnapshot {
  pluginId: string;
  namespace: string;
  ownerType: "thread" | "stream" | "turn" | "agent" | "session";
  ownerId: string;
  schemaVersion: number;
  revision: number;
  data: JsonValue;
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

export type ExecutionPhase = "BeforeTurn" | "BeforeModel" | "ModelPending" | "BeforeTool" | "ToolPending" | "TurnBoundary" | "Suspended";

export interface HandlerCursor {
  eventId: string;
  handlerId: string;
  nextIndex: number;
  payload: JsonValue;
  decisions: readonly JsonValue[];
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

export type CheckpointCause = "ThreadCreated" | "InputCommitted" | "MessageCommitted" | "ExecutionTransition" | "PluginStateCommitted" | "Suspended" | "Resumed" | "Terminal" | "ForkCreated";

export interface CheckpointInfo {
  id: string;
  threadId: string;
  revision: number;
  createdAt: string;
  cause: string;
  forkable: boolean;
  unsafeReason: string | null;
}

export interface HistoryDataPage extends Page<MessageData> {
  checkpointId: string;
  revision: number;
}

export interface Page<T> {
  items: readonly T[];
  nextCursor: string | null;
}

export interface TurnRecord {
  id: string;
  streamId: string;
  scope: JsonObject;
  index: number;
  contextRevision: number;
  assistantMessageId: string | null;
  status: string;
  stopReason: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  error: ErrorInfo | null;
  usage: UsageSummary;
}

export interface ModelAttemptRecord {
  id: string;
  turnId: string;
  streamId: string;
  scope: JsonObject;
  callId: string;
  attemptIndex: number;
  purpose: "primary" | "auxiliary";
  parentToolExecutionId: string | null;
  providerId: string;
  modelId: string;
  providerRequestId: string | null;
  responseMessageId: string | null;
  contextRevision: number;
  startedAt: string;
  firstOutputAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  timeToFirstOutputMs: number | null;
  status: string;
  finishReason: string | null;
  error: ErrorInfo | null;
  usage: ModelUsage;
}

export interface ModelUsage extends TokenCounts {
  provenance: Record<TokenMetric, UsageSource>;
  providerDetails?: JsonValue;
}

export type TokenCounts = Record<TokenMetric, number | null>;

export type UsageSource = "provider" | "derived" | "estimated" | "unavailable";

export interface ToolExecutionRecord {
  resume?: {
    interruptId: string;
    value: JsonValue;
  };
  id: string;
  turnId: string;
  streamId: string;
  scope: JsonObject;
  toolCallId: string;
  parentToolExecutionId: string | null;
  toolName: string;
  arguments: JsonObject;
  policyDecision: {
    decision: "allowed" | "denied";
    reason?: string;
  } | null;
  status: "pending" | "suspended" | "resuming" | "running" | "succeeded" | "failed" | "denied" | "cancelled" | "interrupted";
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  resultMessageId: string | null;
  result: MessageData | null;
  error: ErrorInfo | null;
  idempotencyKey: string | null;
}

export interface StoredRecord {
  readonly id: string;
  readonly namespace: string;
  readonly scope: Scope;
  readonly data: JsonValue;
  readonly createdAt: string;
}

export interface QueuedInputReceipt {
  id: string;
  threadId: string;
}

export interface ExecutionReceipt {
  streamId: string;
  threadId: string;
}

export type SendSignalOptions = SignalTarget & {
  content: string | readonly ContentPart[];
  persist?: boolean;
  tagName?: string;
  attributes?: Record<string, string | number | boolean>;
  metadata?: JsonObject;
};

export type SignalTarget = {
  streamId: string;
  threadId?: never;
} | {
  threadId: string;
  streamId?: never;
};
