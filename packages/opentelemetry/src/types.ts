import type { Span } from "@opentelemetry/api";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { JsonObject, MessageData, ModelUsage } from "@tessar/core";

export interface TraceAdapter {
  createExporter(): SpanExporter;
}

export interface OpenTelemetryOptions {
  adapters: readonly TraceAdapter[];
  /** Export each completed span immediately instead of batching. Defaults to false. */
  realtime?: boolean;
  /** OTel service.name resource attribute. */
  serviceName?: string;
  /** Override the shared trace name; individual tool/model names are unchanged. */
  traceName?: string;
  /** Application-defined tags propagated to every observation. */
  tags?: readonly string[];
}

export type ObservationType = "agent" | "span" | "generation" | "tool";
export interface ObservationAttributes {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  model?: string;
  modelParameters?: Record<string, string | number>;
  usage?: ModelUsage;
  completionStartTime?: Date;
  level?: "ERROR" | "WARNING";
  statusMessage?: string;
}

interface TurnTrace {
  span: Span;
  output: MessageData[];
}
export type ThreadTraceState = {
  turnCount: number;
  turnId: string;
};
export interface ExecutionTrace {
  root: Span;
  link?: ThreadTraceState;
  turns: Map<string, TurnTrace>;
  output: MessageData[];
  models: Map<string, Span>;
  tools: Map<string, Span>;
  calls: Map<string, { name: string; arguments: JsonObject }>;
  firstOutputs: Set<string>;
  currentTurn?: string;
  turnStartedAt?: string;
  identity: Record<string, unknown>;
}
