import type { Attributes } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { MessageData, ModelRequest, ModelUsage } from "@tessar/core";
import { mappedSpan, readJson } from "../attributes.js";
import { OTLPAdapter } from "./otlp.js";
import { inputMessages } from "../messages.js";

export interface ArizeOptions {
  apiKey?: string;
  spaceId?: string;
  projectName?: string;
  /** Full OTLP/HTTP trace URL; defaults to ARIZE_COLLECTOR_ENDPOINT or Arize AX. */
  endpoint?: string;
}

function messages(
  attributes: Attributes,
  prefix: string,
  values: readonly Pick<MessageData, "role" | "content" | "toolCallId">[],
): void {
  values.forEach((message, index) => {
    const base = `${prefix}.${index}.message`;
    attributes[base + ".role"] = message.role;
    if (message.toolCallId)
      attributes[base + ".tool_call_id"] = message.toolCallId;
    attributes[base + ".content"] = message.content
      .filter((part) => part.type === "text" || part.type === "data")
      .map((part) =>
        part.type === "text" ? part.text : JSON.stringify(part.data),
      )
      .join("\n");
    let toolIndex = 0;
    let contentIndex = 0;
    message.content.forEach((part) => {
      if (part.type === "tool-call") {
        const target = `${base}.tool_calls.${toolIndex++}.tool_call`;
        attributes[target + ".id"] = part.toolCallId;
        attributes[target + ".function.name"] = part.name;
        attributes[target + ".function.arguments"] = JSON.stringify(
          part.arguments,
        );
      } else if (
        part.type === "text" ||
        part.type === "reasoning" ||
        part.type === "data"
      ) {
        const key = `${base}.contents.${contentIndex++}`;
        attributes[key + ".message_content.type"] =
          part.type === "data" ? "text" : part.type;
        attributes[key + ".message_content.text"] =
          part.type === "data" ? JSON.stringify(part.data) : part.text;
      }
    });
  });
}

function conversationText(
  values: readonly Pick<MessageData, "role" | "content">[],
): string {
  return values
    .map((message) =>
      [
        message.role.toUpperCase(),
        ...message.content.map((part) => {
          if (part.type === "text") return part.text;
          if (part.type === "reasoning") return "[Thinking]\n" + part.text;
          if (part.type === "tool-call")
            return (
              `[Tool call: ${part.name}]\n` + JSON.stringify(part.arguments)
            );
          if (part.type === "data") return JSON.stringify(part.data);
          return `[${part.type}: ${part.mediaType}]`;
        }),
      ].join("\n"),
    )
    .join("\n\n");
}

/** Arize AX authentication, project resource and OpenInference field mapping. */
export class ArizeAdapter extends OTLPAdapter {
  readonly #projectName: string;
  constructor(options: ArizeOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ARIZE_API_KEY;
    const spaceId = options.spaceId ?? process.env.ARIZE_SPACE_ID;
    const projectName = options.projectName ?? process.env.ARIZE_PROJECT_NAME;
    if (!apiKey || !spaceId || !projectName)
      throw Error(
        "Arize requires apiKey, spaceId and projectName or their ARIZE_* environment variables",
      );
    super({
      endpoint:
        options.endpoint ??
        process.env.ARIZE_COLLECTOR_ENDPOINT ??
        "https://otlp.arize.com/v1/traces",
      headers: {
        authorization: apiKey,
        "arize-space-id": spaceId,
        "arize-interface": "otel",
      },
    });
    this.#projectName = projectName;
  }
  protected override mapSpan(span: ReadableSpan): ReadableSpan {
    const attributes: Attributes = { ...span.attributes };
    // AX normalizes GenAI messages too. Export one conversation representation
    // to avoid merging a second system prompt or incompatible tool-use blocks.
    for (const key of [
      "gen_ai.input.messages",
      "gen_ai.output.messages",
      "gen_ai.system_instructions",
      "gen_ai.tool.definitions",
    ])
      delete attributes[key];
    const type = String(span.attributes["tessar.observation.type"]);
    attributes["openinference.span.kind"] =
      (
        {
          agent: "AGENT",
          span: "CHAIN",
          generation: "LLM",
          tool: "TOOL",
        } as Record<string, string>
      )[type] ?? "CHAIN";
    for (const [key, target] of Object.entries({
      "tessar.input": "input.value",
      "tessar.output": "output.value",
    })) {
      if (span.attributes[key] !== undefined) {
        attributes[target] = span.attributes[key];
        attributes[target.replace(".value", ".mime_type")] = "application/json";
      }
    }
    // I/O panels use the conversation, not Tessar's internal request envelope.
    if (type === "span" || type === "generation") {
      const request = readJson<Partial<ModelRequest>>(span, "tessar.input");
      if (request?.messages) {
        const values = request.instructions
          ? inputMessages({
              instructions: request.instructions,
              messages: request.messages,
            })
          : request.messages;
        attributes["input.value"] = conversationText(values);
        attributes["input.mime_type"] = "text/plain";
      }
      const output = readJson<MessageData[]>(span, "tessar.output");
      if (Array.isArray(output)) {
        attributes["output.value"] = conversationText(output);
        attributes["output.mime_type"] = "text/plain";
      }
    }
    if (type === "generation") {
      attributes["llm.model_name"] = span.attributes["gen_ai.request.model"];
      attributes["llm.provider"] = span.attributes["gen_ai.provider.name"];
      const request = readJson<ModelRequest>(span, "tessar.input");
      if (request?.options)
        attributes["llm.invocation_parameters"] = JSON.stringify(
          request.options,
        );
      if (request?.messages)
        messages(attributes, "llm.input_messages", inputMessages(request));
      request?.tools.forEach((tool, index) => {
        const key = `llm.tools.${index}.tool`;
        attributes[key + ".name"] = tool.name;
        attributes[key + ".description"] = tool.description;
        attributes[key + ".json_schema"] = JSON.stringify(tool.inputSchema);
      });
      const output = readJson<MessageData>(span, "tessar.output");
      if (output?.content) {
        messages(attributes, "llm.output_messages", [output]);
        attributes["output.value"] = conversationText([output]);
        attributes["output.mime_type"] = "text/plain";
      }
      const usage = readJson<ModelUsage>(span, "tessar.usage");
      for (const [key, count] of Object.entries({
        prompt: usage?.inputTokens,
        completion: usage?.outputTokens,
        total: usage?.totalTokens,
        "prompt_details.cache_read": usage?.cacheReadInputTokens,
        "prompt_details.cache_write": usage?.cacheWriteInputTokens,
        "completion_details.reasoning": usage?.reasoningOutputTokens,
      }))
        if (count !== null && count !== undefined)
          attributes["llm.token_count." + key] = count;
    }
    if (type === "tool") {
      attributes["tool.name"] = span.name;
      attributes["tool.description"] =
        span.attributes["gen_ai.tool.description"];
      attributes["tool.parameters"] =
        span.attributes["tessar.metadata.toolParameters"];
      attributes["tool.id"] = span.attributes["gen_ai.tool.call.id"];
    }
    const metadata = Object.fromEntries(
      Object.entries(span.attributes)
        .filter(([key]) => key.startsWith("tessar.metadata."))
        .map(([key, value]) => [
          key.slice("tessar.metadata.".length),
          typeof value === "string" ? JSON.parse(value) : value,
        ]),
    );
    attributes.metadata = JSON.stringify(metadata);
    return mappedSpan(
      span,
      attributes,
      span.resource.merge(
        resourceFromAttributes({
          "openinference.project.name": this.#projectName,
        }),
      ),
    );
  }
}
