import type { Instruction } from "../instructions/instruction.js";
import type { MessageData } from "../messages/message.js";
import type { JsonObject } from "../json.js";
import type { ModelUsage } from "../trace/usage.js";
import type { MetadataResolver } from "./profile.js";
export interface ModelRef {
  providerId: string;
  modelId: string;
  /** Non-secret identity of a concrete connection, when supplied by an adapter. */
  connectionId?: string;
}
export interface ModelConnectionDescriptor {
  providerId: string;
  connectionId: string;
  protocol: string;
  endpoint: string;
}
export interface ToolDescription {
  name: string;
  description: string;
  inputSchema: JsonObject;
}
export interface ModelRequest {
  model: ModelRef;
  instructions: Instruction;
  messages: readonly MessageData[];
  tools: readonly ToolDescription[];
  options?: JsonObject;
}
export interface ModelCallContext {
  signal: AbortSignal;
  /** Observation clock supplied by the runtime. */
  now?(): string;
  /** Transform an encoded JSON body immediately before invoking the provider SDK. */
  prepareRequest?(protocol: string, body: JsonObject): Promise<JsonObject>;
}
export interface ProviderRequest {
  model: ModelRef;
  protocol: string;
  attemptId: string;
  purpose: "primary" | "auxiliary";
  body: JsonObject;
}
export interface ModelResponse {
  message: MessageData;
  usage?: ModelUsage;
  finishReason?: string;
  providerRequestId?: string;
}
export interface PartIdentity {
  messageId: string;
  partId: string;
  partIndex: number;
}
export interface PartTiming {
  startedAt: string;
  boundary: "provider" | "observed";
}
export type ModelPartChunk =
  | {
      [K in "text" | "reasoning"]:
        | (PartIdentity & PartTiming & { type: `${K}.start` })
        | (PartIdentity & { type: `${K}.delta`; delta: string })
        | (PartIdentity &
            PartTiming & {
              type: `${K}.end`;
              endedAt: string;
              status: "completed" | "interrupted";
              text: string;
            });
    }["text" | "reasoning"]
  | (PartIdentity &
      PartTiming & {
        type: "tool.call.start";
        toolCallId?: string;
        name?: string;
      })
  | (PartIdentity &
      PartTiming & { type: "tool.call.end"; endedAt: string } & (
        | {
            status: "completed";
            toolCallId: string;
            name: string;
            arguments: JsonObject;
          }
        | { status: "interrupted"; toolCallId?: string; name?: string }
      ));
type PartPayload<C> = C extends ModelPartChunk ? Omit<C, "type"> : never;
export type PartEvent<N extends ModelPartChunk["type"]> = PartPayload<
  Extract<ModelPartChunk, { type: N }>
> & {
  attemptId: string;
  purpose: "primary" | "auxiliary";
  parentToolExecutionId: string | null;
};
export type ModelChunk =
  | ModelPartChunk
  | { type: "usage"; usage: ModelUsage }
  | { type: "response"; response: ModelResponse };
export interface ModelAdapter {
  readonly ref: ModelRef;
  readonly connection?: ModelConnectionDescriptor;
  readonly options?: object;
  /** Select another model without changing credentials, endpoint or client. */
  withModel?(modelId: string): ModelAdapter;
  /** Map a supported effort level into this adapter's native request options. */
  effortOptions?(level: string, options: JsonObject): JsonObject;
  validate(request: ModelRequest): void;
  stream(
    request: ModelRequest,
    context: ModelCallContext,
  ): AsyncIterable<ModelChunk>;
}
export type ModelOptions<M> = M extends { readonly options: infer O }
  ? Partial<O>
  : JsonObject;
export interface ModelProviderRegistration {
  id: string;
  create(modelId: string): ModelAdapter;
  metadata?: MetadataResolver;
  endpoint?: string;
  metadataPartition?: string;
  catalogModelRef?: (ref: ModelRef) => ModelRef | null;
  catalogMappingVersion?: number;
}
