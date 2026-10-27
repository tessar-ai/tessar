import {
  AssistantMessage,
  fail,
  type ContentPart,
  type JsonValue,
  type MessageData,
  type ModelRef,
  type ModelRequest,
  type ModelConnectionDescriptor,
} from "@tessar/core";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";
import {
  responseError,
  functionArguments,
  functionIdentity,
} from "./response-error.js";

export interface ChatAssistant {
  role: "assistant";
  content: string | null;
  refusal?: string;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
}
interface ChatContinuity extends ModelRef {
  connection?: ModelConnectionDescriptor;
  codec: "openai.chat-completions";
  version: 1;
  message: ChatAssistant;
}
function toolOutput(message: MessageData): string {
  return message.content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "data") return JSON.stringify(part.data);
      return fail(
        "UnsupportedContext",
        "Chat tool output requires text or JSON data",
      );
    })
    .join("");
}

export function encodeChatMessages(
  request: ModelRequest,
  connection?: ModelConnectionDescriptor,
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];
  const instructions = request.instructions.sections
    .map((section) => section.content)
    .join("\n\n");
  if (
    request.instructions.sections.some((section) => section.content.length > 0)
  )
    messages.push({ role: "system", content: instructions });
  for (const message of request.messages) {
    if (message.providerState !== undefined) {
      const state = message.providerState as unknown as ChatContinuity;
      if (
        !state ||
        state.codec !== "openai.chat-completions" ||
        state.version !== 1 ||
        state.providerId !== request.model.providerId ||
        state.modelId !== request.model.modelId ||
        state.connectionId !== request.model.connectionId ||
        state.message?.role !== "assistant" ||
        (state.connection !== undefined &&
          (state.connection.endpoint !== connection?.endpoint ||
            state.connection.protocol !== connection?.protocol))
      )
        fail(
          "UnsupportedContext",
          "Opaque Chat context requires its original model, connection and protocol",
        );
      messages.push(state.message);
      continue;
    }
    if (message.content.some((part) => part.type === "reasoning"))
      fail(
        "UnsupportedContext",
        "Reasoning history requires native provider continuity",
      );
    if (message.role === "tool") {
      if (!message.toolCallId)
        fail("InvalidMessage", "Tool history requires toolCallId");
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: toolOutput(message),
      });
      continue;
    }
    if (message.role === "assistant") {
      const text: string[] = [],
        calls: NonNullable<ChatAssistant["tool_calls"]> = [];
      for (const part of message.content) {
        if (part.type === "text") text.push(part.text);
        else if (part.type === "tool-call")
          calls.push({
            id: part.toolCallId,
            type: "function",
            function: {
              name: part.name,
              arguments: JSON.stringify(part.arguments),
            },
          });
        else fail("UnsupportedContext", "Unsupported Chat assistant content");
      }
      messages.push({
        role: "assistant",
        content: text.length ? text.join("") : null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }
    if (message.role === "system") {
      if (message.content.some((part) => part.type !== "text"))
        fail("UnsupportedContext", "System content requires text");
      messages.push({
        role: "system",
        content: message.content
          .map((part) => (part as { text: string }).text)
          .join(""),
      });
      continue;
    }
    if (message.content.every((part) => part.type === "text")) {
      messages.push({
        role: "user",
        content: message.content.map((part) => part.text).join(""),
      });
      continue;
    }
    const content = message.content.map((part) => {
      if (part.type === "text")
        return { type: "text" as const, text: part.text };
      if (part.type === "image")
        return {
          type: "image_url" as const,
          image_url: {
            url: /^(https?:|data:)/.test(part.data)
              ? part.data
              : `data:${part.mediaType};base64,${part.data}`,
          },
        };
      if (part.type === "file")
        return { type: "file" as const, file: { file_data: part.data } };
      return fail("UnsupportedContext", "Unsupported Chat user content");
    });
    messages.push({ role: "user", content });
  }
  return messages;
}

export function decodeChatMessage(
  message: ChatAssistant,
  ref: ModelRef,
  id: string,
  connection?: ModelConnectionDescriptor,
): AssistantMessage {
  const parts: ContentPart[] = [];
  for (const text of [message.reasoning_content, message.reasoning])
    if (text) parts.push({ type: "reasoning", text });
  if (message.content) parts.push({ type: "text", text: message.content });
  if (message.refusal) parts.push({ type: "text", text: message.refusal });
  const ids = new Set<string>();
  for (const call of message.tool_calls ?? []) {
    functionIdentity(ref, call.id, call.function.name);
    if (ids.has(call.id))
      throw responseError(ref, "Duplicate Chat function identity");
    ids.add(call.id);
    const args = functionArguments(call.function.arguments, ref);
    parts.push({
      type: "tool-call",
      toolCallId: call.id,
      name: call.function.name,
      arguments: args as Record<string, JsonValue>,
    });
  }
  return new AssistantMessage(parts, {
    id,
    providerState: {
      codec: "openai.chat-completions",
      version: 1,
      ...ref,
      message,
      ...(connection ? { connection: { ...connection } } : {}),
    } as unknown as JsonValue,
  });
}
