import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { MessageData, ModelRequest, ModelUsage } from "@tessar/core";
import { readJson } from "../attributes.js";
import { genAIMessages, inputMessages } from "../messages.js";

/** OpenLLMetry compatibility fields for receivers that still consume its names. */
export function openLLMetryAttributes(span: ReadableSpan): Attributes {
  const attributes: Attributes = { ...span.attributes };
  const type = String(span.attributes["tessar.observation.type"]);
  const kind = (
    { agent: "agent", span: "task", tool: "tool" } as Record<string, string>
  )[type];
  if (kind) attributes["traceloop.span.kind"] = kind;
  attributes["traceloop.entity.name"] = span.name;
  attributes["traceloop.workflow.name"] = span.attributes["tessar.trace.name"];
  for (const direction of ["input", "output"])
    if (span.attributes["tessar." + direction] !== undefined)
      attributes["traceloop.entity." + direction] =
        span.attributes["tessar." + direction];
  for (const [key, value] of Object.entries(span.attributes))
    if (key.startsWith("tessar.metadata."))
      attributes[
        key.replace("tessar.metadata.", "traceloop.association.properties.")
      ] = value;
  if (type !== "generation") return attributes;

  attributes["llm.request.type"] = "chat";
  attributes["gen_ai.system"] = span.attributes["gen_ai.provider.name"];
  const request = readJson<ModelRequest>(span, "tessar.input");
  if (request?.messages)
    messages(attributes, "gen_ai.prompt", inputMessages(request));
  // OpenAI-style tool results are text. Some receivers coerce structured
  // response objects to "[object Object]" instead of rendering their JSON.
  if (request?.messages)
    attributes["gen_ai.input.messages"] = JSON.stringify(
      genAIMessages(request.messages).map((message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.type === "tool_call_response" &&
          "response" in part &&
          typeof part.response !== "string"
            ? { ...part, response: JSON.stringify(part.response) }
            : part,
        ),
      })),
    );
  const output = readJson<MessageData>(span, "tessar.output");
  if (output?.content) messages(attributes, "gen_ai.completion", [output]);
  const usage = readJson<ModelUsage>(span, "tessar.usage");
  for (const [key, count] of Object.entries({
    prompt_tokens: usage?.inputTokens,
    completion_tokens: usage?.outputTokens,
    total_tokens: usage?.totalTokens,
    cache_read_input_tokens: usage?.cacheReadInputTokens,
    cache_creation_input_tokens: usage?.cacheWriteInputTokens,
    reasoning_tokens: usage?.reasoningOutputTokens,
  }))
    if (count !== null && count !== undefined)
      attributes["gen_ai.usage." + key] = count;
  if (usage?.totalTokens !== null && usage?.totalTokens !== undefined)
    attributes["llm.usage.total_tokens"] = usage.totalTokens;
  return attributes;
}

function messages(
  attributes: Attributes,
  prefix: string,
  values: readonly Pick<MessageData, "role" | "content" | "toolCallId">[],
): void {
  values.forEach((message, index) => {
    const key = `${prefix}.${index}`;
    attributes[key + ".role"] = message.role;
    if (message.toolCallId)
      attributes[key + ".tool_call_id"] = message.toolCallId;
    attributes[key + ".content"] = message.content
      .filter((part) => part.type !== "reasoning" && part.type !== "tool-call")
      .map((part) =>
        part.type === "text"
          ? part.text
          : JSON.stringify(part.type === "data" ? part.data : part),
      )
      .join("\n");
    message.content
      .filter((part) => part.type === "tool-call")
      .forEach((part, callIndex) => {
        const call = `${key}.tool_calls.${callIndex}`;
        attributes[call + ".id"] = part.toolCallId;
        attributes[call + ".name"] = part.name;
        attributes[call + ".arguments"] = JSON.stringify(part.arguments);
      });
  });
}
