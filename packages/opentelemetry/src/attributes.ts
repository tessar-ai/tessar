import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { MessageData, ModelRequest } from "@tessar/core";
import { genAIMessages } from "./messages.js";
import type { ObservationAttributes, ObservationType } from "./types.js";

/** Shared spans contain standard GenAI fields and lossless Tessar payloads. */
export function observationAttributes(
  type: ObservationType,
  value: ObservationAttributes,
): Attributes {
  const result: Attributes = { "tessar.observation.type": type };
  for (const [key, data] of Object.entries({
    input: value.input,
    output: value.output,
    usage: value.usage,
    "model.parameters": value.modelParameters,
  }))
    if (data !== undefined) result["tessar." + key] = JSON.stringify(data);
  if (value.completionStartTime !== undefined)
    result["tessar.completion_start_time"] =
      value.completionStartTime.toISOString();
  for (const [key, data] of Object.entries(value.metadata ?? {}))
    if (data !== undefined)
      result["tessar.metadata." + key] = JSON.stringify(data);
  if (value.level !== undefined) result["tessar.level"] = value.level;
  if (value.statusMessage !== undefined)
    result["tessar.status_message"] = value.statusMessage;
  if (value.model !== undefined) result["gen_ai.request.model"] = value.model;
  if (typeof value.metadata?.providerId === "string")
    result["gen_ai.provider.name"] = value.metadata.providerId;
  const operation = {
    agent: "invoke_agent",
    generation: "chat",
    tool: "execute_tool",
    span: undefined,
  }[type];
  if (operation) result["gen_ai.operation.name"] = operation;
  if (type === "tool") {
    if (typeof value.metadata?.toolDescription === "string")
      result["gen_ai.tool.description"] = value.metadata.toolDescription;
    if (typeof value.metadata?.toolCallId === "string")
      result["gen_ai.tool.call.id"] = value.metadata.toolCallId;
    if (value.input !== undefined)
      result["gen_ai.tool.call.arguments"] = JSON.stringify(value.input);
    const output = value.output as MessageData | undefined;
    if (output?.role === "tool") {
      const part = genAIMessages([output])[0]!.parts[0]!;
      if ("response" in part)
        result["gen_ai.tool.call.result"] = JSON.stringify(part.response);
    }
  }
  if (type === "generation") {
    const request = value.input as ModelRequest | undefined;
    if (request?.tools)
      result["gen_ai.tool.definitions"] = JSON.stringify(
        request.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      );
    const instructions = request?.instructions?.sections
      .filter((section) => section.content.length > 0)
      .map((section) => ({ type: "text", content: section.content }));
    if (instructions?.length)
      result["gen_ai.system_instructions"] = JSON.stringify(instructions);
    if (request?.messages)
      result["gen_ai.input.messages"] = JSON.stringify(
        genAIMessages(request.messages),
      );
    const output = value.output as MessageData | undefined;
    if (output?.content)
      result["gen_ai.output.messages"] = JSON.stringify(
        genAIMessages([output]),
      );
  }
  for (const [key, count] of Object.entries({
    input_tokens: value.usage?.inputTokens,
    output_tokens: value.usage?.outputTokens,
    "cache_read.input_tokens": value.usage?.cacheReadInputTokens,
    "cache_creation.input_tokens": value.usage?.cacheWriteInputTokens,
    "reasoning.output_tokens": value.usage?.reasoningOutputTokens,
  }))
    if (count !== null && count !== undefined)
      result["gen_ai.usage." + key] = count;
  return result;
}

export function readJson<T>(span: ReadableSpan, key: string): T | undefined {
  const value = span.attributes[key];
  return typeof value === "string" ? (JSON.parse(value) as T) : undefined;
}

/** Exporter-specific snapshots keep mappings isolated from the original span. */
export function mappedSpan(
  span: ReadableSpan,
  attributes: Attributes,
  resource = span.resource,
): ReadableSpan {
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status,
    attributes,
    links: span.links,
    events: span.events,
    duration: span.duration,
    ended: span.ended,
    resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}
