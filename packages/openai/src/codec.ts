import {
  AssistantMessage,
  fail,
  assertJson,
  type ContentPart,
  type JsonValue,
  type ModelRef,
  type ModelRequest,
  type ModelConnectionDescriptor,
} from "@tessar/core";
import {
  functionArguments,
  functionIdentity,
  responseError,
} from "./response-error.js";
import type {
  ResponseInput,
  ResponseOutputItem,
} from "openai/resources/responses/responses";
interface Continuity {
  codec: "openai.responses";
  version: 1;
  providerId: string;
  modelId: string;
  connectionId?: string;
  items: JsonValue[];
  connection?: ModelConnectionDescriptor;
}
function continuity(value: unknown): Continuity | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("codec" in value) ||
    value.codec !== "openai.responses"
  )
    return null;
  const data = value as Continuity;
  if (data.version !== 1 || !Array.isArray(data.items))
    fail("UnsupportedContext", "Unknown OpenAI continuity version");
  return data;
}
export function encodeInput(
  request: ModelRequest,
  connection?: ModelConnectionDescriptor,
): ResponseInput {
  const input: ResponseInput = [];
  for (const message of request.messages) {
    const state = continuity(message.providerState);
    if (state) {
      if (
        state.providerId !== request.model.providerId ||
        state.modelId !== request.model.modelId ||
        state.connectionId !== request.model.connectionId ||
        (state.connection !== undefined &&
          (state.connection.endpoint !== connection?.endpoint ||
            state.connection.protocol !== connection?.protocol))
      )
        fail(
          "UnsupportedContext",
          "Opaque OpenAI context requires its original model",
        );
      input.push(...(state.items as unknown as ResponseInput));
      continue;
    }
    if (
      message.providerState !== undefined ||
      message.content.some((p) => p.type === "reasoning")
    )
      fail("UnsupportedContext", "Unsupported provider continuity");
    if (message.role === "tool") {
      if (message.content.some((p) => p.type !== "text" && p.type !== "data"))
        fail(
          "UnsupportedContext",
          "OpenAI tool output currently requires text or JSON data parts",
        );
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId!,
        output: message.content
          .map((p) =>
            p.type === "text"
              ? p.text
              : p.type === "data"
                ? JSON.stringify(p.data)
                : "",
          )
          .join(""),
      });
      continue;
    }
    const role = message.role;
    let content: any[] = [];
    const flush = () => {
      if (content.length) {
        input.push({ role, content });
        content = [];
      }
    };
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          content.push(
            message.role === "assistant"
              ? { type: "output_text", text: part.text, annotations: [] }
              : { type: "input_text", text: part.text },
          );
          break;
        case "tool-call":
          if (message.role !== "assistant")
            fail("UnsupportedContext", "Tool calls require assistant role");
          flush();
          input.push({
            type: "function_call",
            call_id: part.toolCallId,
            name: part.name,
            arguments: JSON.stringify(part.arguments),
          });
          break;
        case "image":
          if (message.role !== "user")
            fail("UnsupportedContext", "Image input requires user role");
          content.push({
            type: "input_image",
            image_url:
              part.data.startsWith("https:") || part.data.startsWith("data:")
                ? part.data
                : `data:${part.mediaType};base64,${part.data}`,
            detail: "auto",
          });
          break;
        case "file":
          if (message.role !== "user")
            fail("UnsupportedContext", "File input requires user role");
          content.push({
            type: "input_file",
            file_data: part.data,
            filename: message.id,
          });
          break;
        default:
          fail("UnsupportedContext", "Unsupported OpenAI message part");
      }
    }
    flush();
  }
  return input;
}
export function decodeOutput(
  items: readonly unknown[],
  ref: ModelRef,
  responseId: string,
  connection?: ModelConnectionDescriptor,
): AssistantMessage {
  assertJson(items);
  const parts: ContentPart[] = [];
  const callIds = new Set<string>();
  for (const raw of items) {
    const item = raw as unknown as ResponseOutputItem;
    switch (item.type) {
      case "message":
        for (const content of item.content) {
          if (content.type === "output_text")
            parts.push({ type: "text", text: content.text });
          else if (content.type === "refusal")
            parts.push({ type: "text", text: content.refusal });
          else fail("UnsupportedResponse", "Unsupported OpenAI output content");
        }
        break;
      case "reasoning":
        for (const summary of item.summary ?? [])
          parts.push({ type: "reasoning", text: summary.text });
        break;
      case "function_call": {
        const identity = functionIdentity(ref, item.call_id, item.name);
        if (callIds.has(identity.toolCallId))
          throw responseError(ref, "Duplicate function identity");
        callIds.add(identity.toolCallId);
        const args = functionArguments(item.arguments, ref);
        parts.push({
          type: "tool-call",
          ...identity,
          arguments: args,
        });
        break;
      }
      default:
        fail("UnsupportedResponse", "Unsupported OpenAI output item");
    }
  }
  return new AssistantMessage(parts, {
    id: responseId,
    providerState: {
      codec: "openai.responses",
      version: 1,
      ...ref,
      ...(connection ? { connection: { ...connection } } : {}),
      items: items as JsonValue[],
    },
  });
}
