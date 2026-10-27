import OpenAI, { OpenAIError, type ClientOptions } from "openai";
import type {
  ResponseUsage,
  ResponseCreateParamsStreaming,
} from "openai/resources/responses/responses";
import {
  errorInfo,
  MessageCodec,
  fail,
  normalizeUsage,
  assertJson,
  snapshotModelOptions,
  type JsonObject,
  type ModelCallContext,
  type ModelAdapter,
  type ModelChunk,
  type ModelRef,
  type ModelRequest,
  type ModelConnectionDescriptor,
} from "@tessar/core";
import { Parts } from "./parts.js";
import {
  functionArguments,
  functionIdentity,
  responseError,
} from "./response-error.js";
import { decodeOutput, encodeInput } from "./codec.js";
export interface OpenAIOptions extends ClientOptions {
  providerId?: string;
  metadataPartition?: string;
}
// Connection settings must never enter either protocol's request body.
export const clientKeys = [
  "apiKey",
  "adminAPIKey",
  "organization",
  "project",
  "webhookSecret",
  "baseURL",
  "dataResidency",
  "timeout",
  "fetchOptions",
  "fetch",
  "maxRetries",
  "defaultHeaders",
  "defaultQuery",
  "dangerouslyAllowBrowser",
  "logLevel",
  "logger",
  "workloadIdentity",
  "credential",
  "provider",
  "x509Transport",
] as const satisfies readonly (keyof ClientOptions)[];
export function createClient(options: OpenAIOptions): OpenAI {
  const { providerId, metadataPartition, ...clientOptions } = options;
  return new OpenAI(clientOptions);
}
export function validateRequest(
  request: ModelRequest,
  ref: ModelRef,
  api: "responses" | "chat-completions",
): void {
  const chat = api === "chat-completions";
  if (
    request.model.providerId !== ref.providerId ||
    request.model.modelId !== ref.modelId
  )
    fail(
      "UnsupportedContext",
      chat
        ? "Chat model or connection identity mismatch"
        : "Model identity mismatch",
    );
  if (request.model.connectionId !== ref.connectionId)
    fail(
      "UnsupportedContext",
      chat
        ? "Chat model or connection identity mismatch"
        : "Model connection mismatch",
    );
  for (const key of [
    "connectionId",
    "api",
    "model",
    "input",
    "messages",
    "instructions",
    "tools",
    "stream",
    ...(chat ? ["functions", "function_call"] : []),
    ...clientKeys,
  ])
    if (request.options && key in request.options)
      fail(
        "UnsupportedOption",
        key +
          (chat
            ? " is owned by the connection or Agent runtime"
            : " is owned by the model connection or Agent runtime"),
      );
  validateLoopOptions(request.options ?? {}, api);
}
function validateLoopOptions(
  options: Record<string, unknown>,
  api: "responses" | "chat-completions",
): void {
  if (api === "responses") {
    if (
      options.background === true ||
      options.conversation != null ||
      options.previous_response_id != null ||
      options.context_management != null
    )
      fail(
        "UnsupportedOption",
        "Provider-managed conversations and background execution are not supported by the Agent loop",
      );
  } else {
    if (options.n != null && options.n !== 1)
      fail("UnsupportedOption", "An Agent consumes one Chat completion choice");
    if ("functions" in options || "function_call" in options)
      fail(
        "UnsupportedOption",
        "Legacy function calls are not supported by the Agent loop",
      );
  }
}
function usage(value: ResponseUsage | null | undefined) {
  return normalizeUsage(
    {
      inputTokens: value?.input_tokens,
      outputTokens: value?.output_tokens,
      totalTokens: value?.total_tokens,
      cacheReadInputTokens: value?.input_tokens_details?.cached_tokens,
      cacheWriteInputTokens: value?.input_tokens_details?.cache_write_tokens,
      reasoningOutputTokens: value?.output_tokens_details?.reasoning_tokens,
      uncachedInputTokens:
        value?.input_tokens !== undefined &&
        value?.input_tokens_details?.cached_tokens !== undefined
          ? Math.max(
              0,
              value.input_tokens - value.input_tokens_details.cached_tokens,
            )
          : null,
    },
    value ? JSON.parse(JSON.stringify(value)) : null,
  );
}
export class OpenAIAdapter implements ModelAdapter {
  protected readonly client: OpenAI;
  constructor(
    options: OpenAIOptions,
    readonly ref: ModelRef,
    client?: OpenAI,
    readonly connection?: ModelConnectionDescriptor,
  ) {
    this.client = client ?? createClient(options);
  }
  protected async prepareBody(
    body: object,
    api: "responses" | "chat-completions",
    context: ModelCallContext,
  ): Promise<JsonObject> {
    if (!context.prepareRequest) return body as JsonObject;
    const prepared = await context.prepareRequest(
      api,
      snapshotModelOptions(body),
    );
    context.signal.throwIfAborted();
    try {
      assertJson(prepared);
    } catch {
      fail("InvalidHookResult", "Provider request body must be JSON data");
    }
    if (!prepared || typeof prepared !== "object" || Array.isArray(prepared))
      fail("InvalidHookResult", "Provider request body must be an object");
    if (prepared.model !== this.ref.modelId || prepared.stream !== true)
      fail(
        "UnsupportedOption",
        "Provider request cannot change the model or disable streaming",
      );
    // Native OpenRouter routing may use a body field named provider; it is not
    // the SDK client's workload-identity provider option at this boundary.
    for (const key of [
      ...clientKeys.filter((key) => key !== "provider"),
      "connectionId",
      "api",
    ])
      if (key in prepared)
        fail("UnsupportedOption", key + " belongs to the provider connection");
    validateLoopOptions(prepared, api);
    return prepared;
  }
  validate(request: ModelRequest): void {
    try {
      validateRequest(request, this.ref, "responses");
      encodeInput(request, this.connection);
    } catch (error) {
      errorInfo(error, { source: "tessar", ...this.ref });
      throw error;
    }
  }
  async *stream(
    request: ModelRequest,
    context: ModelCallContext,
  ): AsyncIterable<ModelChunk> {
    this.validate(request);
    context.signal.throwIfAborted();
    try {
      const body = await this.prepareBody(
        {
          ...request.options,
          model: this.ref.modelId,
          ...(request.instructions.sections.some(
            (section) => section.content.length > 0,
          )
            ? {
                instructions: request.instructions.sections
                  .map((s) => s.content)
                  .join("\n\n"),
              }
            : {}),
          input: encodeInput(request, this.connection),
          ...(request.tools.length
            ? {
                tools: request.tools.map((t) => ({
                  type: "function" as const,
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema,
                  strict: false,
                })),
              }
            : {}),
          stream: true,
        },
        "responses",
        context,
      );
      const stream = await this.client.responses.create(
        body as unknown as ResponseCreateParamsStreaming,
        { signal: context.signal },
      );
      const parts = new Parts(this.ref, context);
      let terminal = false;
      for await (const event of stream) {
        context.signal.throwIfAborted();
        switch (event.type) {
          case "response.created":
            parts.identify(event.response.id);
            break;
          case "response.content_part.added":
            if (
              event.part.type === "output_text" ||
              event.part.type === "refusal"
            )
              yield* parts.start(
                "text",
                event.item_id + ":" + event.content_index,
                "provider",
              );
            break;
          case "response.reasoning_summary_part.added":
            yield* parts.start(
              "reasoning",
              event.item_id + ":summary:" + event.summary_index,
              "provider",
            );
            break;
          case "response.output_item.added":
            if (event.item.type === "function_call") {
              functionIdentity(this.ref, event.item.call_id, event.item.name);
              yield* parts.start(
                "tool.call",
                event.item.id ?? event.item.call_id,
                "provider",
              );
            }
            break;
          case "response.output_text.delta":
            yield* parts.delta(
              "text",
              event.item_id + ":" + event.content_index,
              event.delta,
            );
            break;
          case "response.refusal.delta":
            yield* parts.delta(
              "text",
              event.item_id + ":" + event.content_index,
              event.delta,
            );
            break;
          case "response.reasoning_summary_text.delta":
            yield* parts.delta(
              "reasoning",
              event.item_id + ":summary:" + event.summary_index,
              event.delta,
            );
            break;
          case "response.content_part.done":
            if (
              event.part.type === "output_text" ||
              event.part.type === "refusal"
            )
              yield* parts.end(
                "text",
                event.item_id + ":" + event.content_index,
                event.part.type === "output_text"
                  ? event.part.text
                  : event.part.refusal,
              );
            break;
          case "response.reasoning_summary_part.done":
            yield* parts.end(
              "reasoning",
              event.item_id + ":summary:" + event.summary_index,
              event.part.text,
            );
            break;
          case "response.output_item.done":
            if (event.item.type === "function_call")
              yield* parts.end(
                "tool.call",
                event.item.id ?? event.item.call_id,
                {
                  ...functionIdentity(
                    this.ref,
                    event.item.call_id,
                    event.item.name,
                  ),
                  arguments: functionArguments(event.item.arguments, this.ref),
                },
              );
            break;
          case "response.completed": {
            terminal = true;
            const normalized = usage(event.response.usage);
            for (const item of event.response.output) {
              if (item.type === "message") {
                for (const [index, content] of item.content.entries())
                  if (
                    content.type === "output_text" ||
                    content.type === "refusal"
                  )
                    yield* parts.end(
                      "text",
                      item.id + ":" + index,
                      content.type === "output_text"
                        ? content.text
                        : content.refusal,
                      "observed",
                    );
              } else if (item.type === "reasoning") {
                for (const [index, content] of item.summary.entries())
                  yield* parts.end(
                    "reasoning",
                    item.id + ":summary:" + index,
                    content.text,
                    "observed",
                  );
              } else if (item.type === "function_call") {
                yield* parts.end(
                  "tool.call",
                  item.id ?? item.call_id,
                  {
                    ...functionIdentity(this.ref, item.call_id, item.name),
                    arguments: functionArguments(item.arguments, this.ref),
                  },
                  "observed",
                );
              }
            }
            yield { type: "usage", usage: normalized };
            yield {
              type: "response",
              response: {
                message: MessageCodec.encode(
                  decodeOutput(
                    event.response.output,
                    this.ref,
                    parts.messageId,
                    this.connection,
                  ),
                ),
                usage: normalized,
                finishReason: "completed",
                providerRequestId: event.response.id,
              },
            };
            break;
          }
          case "response.incomplete":
          case "response.failed":
            yield { type: "usage", usage: usage(event.response.usage) };
            throw responseError(
              this.ref,
              event.response.error?.message ??
                "OpenAI response did not complete",
              event.response.error?.code ?? "ProviderIncomplete",
            );
          case "error":
            throw responseError(
              this.ref,
              event.message,
              event.code ?? "ProviderError",
            );
        }
      }
      if (!terminal)
        throw responseError(
          this.ref,
          "OpenAI stream ended before completion",
          "ProviderIncomplete",
        );
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      errorInfo(error, {
        source: error instanceof OpenAIError ? "provider" : "tessar",
        ...this.ref,
      });
      throw error;
    }
  }
}
