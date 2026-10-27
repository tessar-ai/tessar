import {
  errorInfo,
  fail,
  MessageCodec,
  normalizeUsage,
  type ModelCallContext,
  type ModelChunk,
  type ModelRequest,
} from "@tessar/core";
import type { CompletionUsage } from "openai/resources/completions";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions/completions";
import { OpenAIError } from "openai";
import { OpenAIAdapter, validateRequest } from "./adapter.js";
import { Parts } from "./parts.js";
import { functionArguments } from "./response-error.js";
import { responseError } from "./response-error.js";
import {
  decodeChatMessage,
  encodeChatMessages,
  type ChatAssistant,
} from "./chat-codec.js";

function usage(value?: CompletionUsage | null) {
  const cached = value?.prompt_tokens_details?.cached_tokens;
  return normalizeUsage(
    {
      inputTokens: value?.prompt_tokens,
      outputTokens: value?.completion_tokens,
      totalTokens: value?.total_tokens,
      cacheReadInputTokens: cached,
      cacheWriteInputTokens: value?.prompt_tokens_details?.cache_write_tokens,
      reasoningOutputTokens: value?.completion_tokens_details?.reasoning_tokens,
      uncachedInputTokens:
        value?.prompt_tokens !== undefined && cached !== undefined
          ? Math.max(0, value.prompt_tokens - cached)
          : null,
    },
    value ? JSON.parse(JSON.stringify(value)) : null,
  );
}

/** Native Chat Completions transport; the Agent consumes the shared ModelChunk contract. */
export class OpenAIChatAdapter extends OpenAIAdapter {
  override validate(request: ModelRequest): void {
    validateRequest(request, this.ref, "chat-completions");
    encodeChatMessages(request, this.connection);
  }

  override async *stream(
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
          messages: encodeChatMessages(request, this.connection),
          ...(request.tools.length
            ? {
                tools: request.tools.map((tool) => ({
                  type: "function" as const,
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  },
                })),
              }
            : {}),
          stream: true,
        },
        "chat-completions",
        context,
      );
      const stream = await this.client.chat.completions.create(
        body as unknown as ChatCompletionCreateParamsStreaming,
        { signal: context.signal },
      );
      const parts = new Parts(this.ref, context);
      let responseId = "",
        finishReason: string | null = null,
        text = "",
        refusal = "";
      let counts: CompletionUsage | null | undefined;
      const thinking: { reasoning_content?: string; reasoning?: string } = {};
      const calls = new Map<
        number,
        NonNullable<ChatAssistant["tool_calls"]>[number]
      >();
      for await (const chunk of stream) {
        context.signal.throwIfAborted();
        if (chunk.id) {
          responseId = chunk.id;
          parts.identify(chunk.id);
        }
        if (chunk.usage) counts = chunk.usage;
        for (const choice of chunk.choices) {
          if (choice.index !== 0)
            throw responseError(
              this.ref,
              "Unexpected multiple Chat completion choices",
            );
          const delta = choice.delta as typeof choice.delta & {
            reasoning_content?: string;
            reasoning?: string;
          };
          if (delta.audio || delta.function_call)
            fail(
              "UnsupportedResponse",
              "Unsupported Chat audio or deprecated function-call output",
            );
          if (delta.content != null) {
            if (typeof delta.content !== "string")
              throw responseError(this.ref, "Chat content must be text");
            text += delta.content;
            yield* parts.delta("text", "text-0", delta.content);
          }
          if (delta.refusal) {
            refusal += delta.refusal;
            yield* parts.delta("text", "refusal", delta.refusal);
          }
          for (const key of ["reasoning_content", "reasoning"] as const) {
            if (delta[key] === undefined || delta[key] === null) continue;
            if (typeof delta[key] !== "string")
              throw responseError(this.ref, "Chat reasoning must be text");
            thinking[key] = (thinking[key] ?? "") + delta[key];
            yield* parts.delta("reasoning", key, delta[key]);
          }
          for (const call of delta.tool_calls ?? []) {
            if (
              !Number.isInteger(call.index) ||
              call.index < 0 ||
              (call.type && call.type !== "function")
            )
              throw responseError(this.ref, "Invalid Chat function-call chunk");
            yield* parts.start("tool.call", "call-" + call.index);
            const saved = calls.get(call.index) ?? {
              id: "",
              type: "function",
              function: { name: "", arguments: "" },
            };
            saved.id += call.id ?? "";
            saved.function.name += call.function?.name ?? "";
            saved.function.arguments += call.function?.arguments ?? "";
            calls.set(call.index, saved);
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      }
      if (!responseId || !finishReason)
        throw responseError(
          this.ref,
          "Chat stream ended before completion",
          "ProviderIncomplete",
        );
      if (finishReason === "tool_calls" && !calls.size)
        throw responseError(
          this.ref,
          "Chat completion ended with missing function calls",
        );
      const message: ChatAssistant = {
        role: "assistant",
        content: text || null,
        ...thinking,
        ...(refusal ? { refusal } : {}),
        ...(calls.size
          ? {
              tool_calls: [...calls]
                .sort(([a], [b]) => a - b)
                .map(([, call]) => call),
            }
          : {}),
      };
      const normalized = usage(counts);
      const decoded = decodeChatMessage(
        message,
        this.ref,
        responseId,
        this.connection,
      );
      yield* parts.closeText();
      for (const [index, call] of calls)
        yield* parts.end(
          "tool.call",
          "call-" + index,
          {
            toolCallId: call.id,
            name: call.function.name,
            arguments: functionArguments(call.function.arguments, this.ref),
          },
          "observed",
        );
      yield { type: "usage", usage: normalized };
      yield {
        type: "response",
        response: {
          message: { ...MessageCodec.encode(decoded), id: parts.messageId },
          usage: normalized,
          finishReason,
          providerRequestId: responseId,
        },
      };
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
