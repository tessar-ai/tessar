import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { MessageData, ModelRequest, ModelUsage } from "@tessar/core";
import { mappedSpan, readJson } from "../attributes.js";
import { genAIMessages, inputMessages } from "../messages.js";
import { OTLPAdapter } from "./otlp.js";

export interface LaminarOptions {
  apiKey?: string;
  /** Full OTLP/HTTP trace URL; otherwise uses LMNR_BASE_URL plus /v1/traces. */
  endpoint?: string;
}

type TraceMessage = Pick<MessageData, "role" | "content" | "toolCallId">;

function conversation(values: readonly TraceMessage[]): string {
  return JSON.stringify(values.map(({ role, content, toolCallId }) => ({
    role, content, ...(toolCallId !== undefined ? { toolCallId } : {}),
  })));
}

/** Laminar's GenAI parser uses thinking and result for these part fields. */
function laminarMessages(values: readonly TraceMessage[]) {
  return genAIMessages(values).map(message => ({ ...message,
    parts: message.parts.map(part => {
      if (part.type === "reasoning") return { ...part, type: "thinking" };
      if (part.type === "tool_call_response" && "response" in part) {
        const { response, ...rest } = part;
        return { ...rest, result: response };
      }
      return part;
    }),
  }));
}

/** Laminar OTLP/HTTP authentication and native span/message mapping. */
export class LaminarAdapter extends OTLPAdapter {
  constructor(options: LaminarOptions = {}) {
    const apiKey = options.apiKey ?? process.env.LMNR_PROJECT_API_KEY;
    if (!apiKey) throw Error("Laminar requires apiKey or LMNR_PROJECT_API_KEY");
    const base = (process.env.LMNR_BASE_URL ?? "https://api.lmnr.ai").replace(/\/+$/, "");
    super({ endpoint: options.endpoint ?? base + "/v1/traces", headers: { Authorization: "Bearer " + apiKey } });
  }

  protected override mapSpan(span: ReadableSpan): ReadableSpan {
    const attributes: Attributes = { ...span.attributes };
    const type = String(span.attributes["tessar.observation.type"]);
    attributes["lmnr.span.type"] = ({ agent: "EXECUTOR", span: "DEFAULT", generation: "LLM", tool: "TOOL" } as Record<string, string>)[type] ?? "DEFAULT";
    if (span.attributes["tessar.metadata.sessionId"] && typeof span.attributes["gen_ai.conversation.id"] === "string")
      attributes["session.id"] = span.attributes["gen_ai.conversation.id"];

    // Association metadata is trace-wide in Laminar. Keep attempt/tool identity
    // on its original tessar.* fields instead of propagating it to every span.
    if (type === "agent") {
      if (span.attributes["tessar.metadata.sessionId"])
        attributes["lmnr.association.properties.session_id"] = span.attributes["gen_ai.conversation.id"];
      if (span.attributes["tessar.trace.tags"] !== undefined)
        attributes["lmnr.association.properties.tags"] = span.attributes["tessar.trace.tags"];
      if (span.attributes["tessar.trace.name"] !== undefined)
        attributes["trace.name"] = span.attributes["tessar.trace.name"];
      for (const [key, value] of Object.entries(span.attributes)) {
        if (!key.startsWith("tessar.metadata.")) continue;
        const parsed = typeof value === "string" ? JSON.parse(value) : value;
        if (parsed !== null && parsed !== undefined)
          attributes[key.replace("tessar.metadata.", "lmnr.association.properties.metadata.")] = typeof parsed === "object" ? JSON.stringify(parsed) : parsed;
      }
    }

    for (const direction of ["input", "output"])
      if (span.attributes["tessar." + direction] !== undefined)
        attributes["lmnr.span." + direction] = span.attributes["tessar." + direction];

    if (type === "agent" || type === "span") {
      const request = readJson<Partial<ModelRequest> | MessageData[]>(span, "tessar.input");
      const values = Array.isArray(request)
        ? inputMessages({ instructions: readJson<ModelRequest["instructions"]>(span, "tessar.instructions") ?? { sections: [] }, messages: request })
        : request?.messages
          ? inputMessages({ instructions: request.instructions ?? { sections: [] }, messages: request.messages })
          : undefined;
      if (values) attributes["lmnr.span.input"] = conversation(values);
      const output = readJson<MessageData[]>(span, "tessar.output");
      if (Array.isArray(output)) attributes["lmnr.span.output"] = conversation(output);
    }
    if (type === "generation") {
      const request = readJson<ModelRequest>(span, "tessar.input");
      if (request?.messages) {
        attributes["lmnr.span.input"] = JSON.stringify(laminarMessages(inputMessages(request)));
        attributes["gen_ai.input.messages"] = JSON.stringify(laminarMessages(request.messages));
      }
      const output = readJson<MessageData>(span, "tessar.output");
      if (output?.content) {
        const messages = JSON.stringify(laminarMessages([output]));
        attributes["lmnr.span.output"] = messages;
        attributes["gen_ai.output.messages"] = messages;
      }
      attributes["gen_ai.system"] = span.attributes["gen_ai.provider.name"];
      const usage = readJson<ModelUsage>(span, "tessar.usage");
      if (usage?.totalTokens !== null && usage?.totalTokens !== undefined)
        attributes["llm.usage.total_tokens"] = usage.totalTokens;
      if (usage?.reasoningOutputTokens !== null && usage?.reasoningOutputTokens !== undefined)
        attributes["gen_ai.usage.reasoning_tokens"] = usage.reasoningOutputTokens;
    }
    if (type === "tool") {
      attributes["lmnr.span.input"] = span.attributes["gen_ai.tool.call.arguments"] ?? attributes["lmnr.span.input"];
      attributes["lmnr.span.output"] = span.attributes["gen_ai.tool.call.result"] ?? attributes["lmnr.span.output"];
    }
    return mappedSpan(span, attributes);
  }
}
