import { z } from "zod";
import { fail, requireId } from "../errors.js";
import {
  assertJson,
  immutable,
  type JsonObject,
  type JsonValue,
} from "../helpers/json.js";
import { ToolMessage } from "../messages/message.js";
import type { TrackedServices } from "../engine/tracked-effects.js";
import { ToolSuspension } from "./suspension.js";
import { canonicalJson } from "../state/commit.js";
export { ToolSuspension } from "./suspension.js";
export type ToolOutput = JsonValue | ToolMessage;
export type ToolResult = ToolOutput | ToolSuspension;
type ToolReturn = ToolResult | Promise<ToolResult>;
type Normalized<T> = T extends ToolSuspension ? ToolSuspension : ToolMessage;
export interface ToolExecutionContext extends TrackedServices {
  readonly signal: AbortSignal;
  readonly threadId: string;
  readonly streamId: string;
  readonly turnId: string;
  readonly toolExecutionId: string;
  emit(progress: JsonValue): void;
  suspend(payload: JsonValue): ToolSuspension;
}
export type ReconcileResult =
  | { status: "completed"; result: ToolOutput }
  | { status: "safeToRetry" }
  | { status: "unknown" };
export interface ToolRecovery<I> {
  idempotencyKey(input: I, identity: { toolExecutionId: string }): string;
  reconcile(operation: {
    id: string;
    input: I;
    key: string;
  }): Promise<ReconcileResult>;
}
export interface ToolDefinition<
  I,
  R = JsonValue,
  O extends ToolReturn = ToolReturn,
> {
  name: string;
  description: string;
  schema: z.ZodType<I>;
  execute(input: I, context: ToolExecutionContext): O;
  resumeSchema?: z.ZodType<R>;
  resume?(
    response: R,
    input: I,
    context: ToolExecutionContext,
  ): ToolResult | Promise<ToolResult>;
  recovery?: ToolRecovery<I>;
}
export class Tool<I = any, R = any, O extends ToolReturn = ToolReturn> {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<I>;
  readonly jsonSchema: JsonObject;
  readonly execute: (
    input: I,
    context: ToolExecutionContext,
  ) => Promise<Normalized<Awaited<O>>>;
  readonly resumeSchema?: z.ZodType<R>;
  readonly resumeJsonSchema: JsonObject;
  readonly resume?: (
    response: R,
    input: I,
    context: ToolExecutionContext,
  ) => ToolResult | Promise<ToolResult>;
  readonly configurationId: string;
  readonly recovery?: ToolRecovery<I>;
  constructor(definition: ToolDefinition<I, R, O>) {
    this.name = requireId(definition.name, "tool name");
    this.description = definition.description;
    this.schema = definition.schema;
    // Zod attaches a non-enumerable Standard Schema validator; keep only JSON.
    this.jsonSchema = immutable(
      JSON.parse(
        JSON.stringify(z.toJSONSchema(definition.schema, { io: "input" })),
      ),
    ) as JsonObject;
    this.resumeSchema = definition.resumeSchema;
    this.resumeJsonSchema = definition.resumeSchema
      ? (immutable(
          JSON.parse(
            JSON.stringify(
              z.toJSONSchema(definition.resumeSchema, { io: "input" }),
            ),
          ),
        ) as JsonObject)
      : {};
    this.resume = definition.resume;
    this.configurationId = canonicalJson(
      definition.resumeSchema || definition.resume
        ? {
            input: this.jsonSchema,
            response: this.resumeJsonSchema,
            resume: !!definition.resume,
          }
        : this.jsonSchema,
    );
    this.execute = async (input, context) => {
      const result = await definition.execute(input, context);
      return (
        result instanceof ToolSuspension ? result : normalizeToolOutput(result)
      ) as Normalized<Awaited<O>>;
    };
    this.recovery = definition.recovery;
  }
}
export function createTool<I, R = JsonValue, O extends ToolReturn = ToolReturn>(
  definition: ToolDefinition<I, R, O>,
): Tool<I, R, O> {
  return new Tool(definition);
}
/** @internal Normalize developer results and bind runtime correlation. */
export function normalizeToolOutput(
  value: ToolOutput,
  toolCallId?: string,
): ToolMessage {
  if (!(value instanceof ToolMessage)) {
    if (value === undefined)
      fail("InvalidToolResult", "Tool execute must return a result");
    assertJson(value);
    value = new ToolMessage(
      typeof value === "string" ? value : [{ type: "data", data: value }],
    );
  }
  if (toolCallId === undefined || value.toolCallId === toolCallId) return value;
  if (value.toolCallId !== undefined)
    fail("InvalidMessage", "Tool result belongs to a different tool call");
  return new ToolMessage(value.content, {
    id: value.id,
    metadata: value.metadata,
    providerState: value.providerState,
    toolCallId,
  });
}
