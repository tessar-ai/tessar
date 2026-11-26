import type { ErrorInfo } from "../errors.js";
import type { JsonObject, JsonValue, Clock, IdGenerator } from "../helpers/json.js";
import type { MessageData } from "../messages/message.js";
import { normalizeUsage, type ModelUsage, type UsageSummary } from "./usage.js";
import type { Checkpoint } from "../state/schema.js";
import type { ModelRef } from "../models/contract.js";

export const TOOL_OUTCOME_UNKNOWN = "ToolOutcomeUnknown";

/** @internal Creates a record only within an active turn. */
export function createModelAttempt(
  context: { ids: IdGenerator; clock: Clock },
  checkpoint: Checkpoint,
  model: ModelRef,
  purpose: ModelAttemptRecord["purpose"],
  parentToolExecutionId: string | null = null,
): ModelAttemptRecord {
  return {
    id: context.ids.next("attempt"),
    turnId: checkpoint.execution!.turnId!,
    streamId: checkpoint.execution!.streamId,
    scope: checkpoint.state.scope,
    callId: context.ids.next("call"),
    attemptIndex: 0,
    purpose,
    parentToolExecutionId,
    providerId: model.providerId,
    modelId: model.modelId,
    providerRequestId: null,
    responseMessageId: null,
    contextRevision: checkpoint.revision,
    startedAt: context.clock.now(),
    firstOutputAt: null,
    endedAt: null,
    durationMs: null,
    timeToFirstOutputMs: null,
    status: "running",
    finishReason: null,
    error: null,
    usage: normalizeUsage({}),
  };
}
export type StreamStatus =
  | "pending"
  | "running"
  | "suspended"
  | "interrupted"
  | "completed"
  | "stopped"
  | "failed"
  | "cancelled";
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
export interface ToolExecutionRecord {
  resume?: { interruptId: string; value: JsonValue };
  id: string;
  turnId: string;
  streamId: string;
  scope: JsonObject;
  toolCallId: string;
  parentToolExecutionId: string | null;
  toolName: string;
  arguments: JsonObject;
  policyDecision: { decision: "allowed" | "denied"; reason?: string } | null;
  status:
    | "pending"
    | "suspended"
    | "resuming"
    | "running"
    | "succeeded"
    | "failed"
    | "denied"
    | "cancelled"
    | "interrupted";
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  resultMessageId: string | null;
  result: MessageData | null;
  error: ErrorInfo | null;
  idempotencyKey: string | null;
}
