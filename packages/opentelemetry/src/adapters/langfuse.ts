import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { ModelRequest, ModelUsage } from "@tessar/core";
import { mappedSpan, readJson } from "../attributes.js";
import { OTLPAdapter } from "./otlp.js";
import { inputMessages } from "../messages.js";

export interface LangfuseOptions {
  publicKey?: string;
  secretKey?: string;
  /** Cloud region or self-hosted base URL. Defaults to LANGFUSE_BASE_URL or EU Cloud. */
  baseUrl?: string;
  prompt?: { name: string; version: number };
}

// Langfuse buckets are exclusive; cached/reasoning tokens already belong to totals.
function usageDetails(usage: ModelUsage): Record<string, number> | undefined {
  const details: Record<string, number> = {};
  const read = usage.cacheReadInputTokens,
    write = usage.cacheWriteInputTokens;
  if (usage.inputTokens !== null) {
    if ((read ?? 0) + (write ?? 0) <= usage.inputTokens) {
      details.input = usage.inputTokens - (read ?? 0) - (write ?? 0);
      if (read !== null) details.input_cached_tokens = read;
      if (write !== null) details.input_cache_write = write;
    } else details.input = usage.inputTokens;
  } else {
    if (read !== null) details.input_cached_tokens = read;
    if (write !== null) details.input_cache_write = write;
    if (usage.uncachedInputTokens !== null)
      details.input = usage.uncachedInputTokens;
  }
  if (usage.outputTokens !== null) {
    const reasoning = usage.reasoningOutputTokens;
    if (reasoning !== null && reasoning <= usage.outputTokens) {
      details.output = usage.outputTokens - reasoning;
      details.output_reasoning_tokens = reasoning;
    } else details.output = usage.outputTokens;
  } else if (usage.reasoningOutputTokens !== null)
    details.output_reasoning_tokens = usage.reasoningOutputTokens;
  if (usage.totalTokens !== null) details.total = usage.totalTokens;
  return Object.keys(details).length ? details : undefined;
}

/** Maps shared spans to Langfuse ingestion v4; no Langfuse SDK is required. */
export class LangfuseAdapter extends OTLPAdapter {
  readonly #prompt?: { name: string; version: number };
  constructor(options: LangfuseOptions = {}) {
    const publicKey = options.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = options.secretKey ?? process.env.LANGFUSE_SECRET_KEY;
    if (!publicKey || !secretKey)
      throw Error(
        "Langfuse requires publicKey and secretKey or LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY",
      );
    const base = (
      options.baseUrl ??
      process.env.LANGFUSE_BASE_URL ??
      "https://cloud.langfuse.com"
    ).replace(/\/+$/, "");
    super({
      endpoint: base + "/api/public/otel/v1/traces",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(publicKey + ":" + secretKey).toString("base64"),
        "x-langfuse-ingestion-version": "4",
      },
    });
    this.#prompt = options.prompt ? { ...options.prompt } : undefined;
  }
  protected override mapSpan(span: ReadableSpan): ReadableSpan {
    const attributes: Attributes = { ...span.attributes };
    // A Langfuse Session groups invocation traces for one Tessar Thread.
    // The original Tessar Session ID remains in observation metadata.
    if (
      span.attributes["tessar.metadata.sessionId"] &&
      typeof span.attributes["gen_ai.conversation.id"] === "string"
    )
      attributes["session.id"] = span.attributes["gen_ai.conversation.id"];
    const keys: Record<string, string> = {
      "tessar.observation.type": "langfuse.observation.type",
      "tessar.trace.name": "langfuse.trace.name",
      "tessar.trace.tags": "langfuse.trace.tags",
      "tessar.input": "langfuse.observation.input",
      "tessar.output": "langfuse.observation.output",
      "tessar.level": "langfuse.observation.level",
      "tessar.status_message": "langfuse.observation.status_message",
      "tessar.completion_start_time":
        "langfuse.observation.completion_start_time",
      "tessar.model.parameters": "langfuse.observation.model.parameters",
      "gen_ai.request.model": "langfuse.observation.model.name",
    };
    for (const [key, value] of Object.entries(span.attributes)) {
      const target =
        keys[key] ??
        (key.startsWith("tessar.metadata.")
          ? key.replace("tessar.metadata.", "langfuse.observation.metadata.")
          : undefined);
      if (target && value !== undefined) attributes[target] = value;
    }
    const request = readJson<Partial<ModelRequest>>(span, "tessar.input");
    if (request?.instructions && request.messages) {
      const { instructions, ...input } = request;
      attributes["langfuse.observation.input"] = JSON.stringify({
        ...input,
        messages: inputMessages({ instructions, messages: request.messages }),
      });
    }
    const usage = readJson<ModelUsage>(span, "tessar.usage");
    const details = usage && usageDetails(usage);
    if (details)
      attributes["langfuse.observation.usage_details"] =
        JSON.stringify(details);
    if (
      this.#prompt &&
      span.attributes["tessar.observation.type"] === "generation" &&
      readJson(span, "tessar.metadata.purpose") !== "auxiliary"
    ) {
      attributes["langfuse.observation.prompt.name"] = this.#prompt.name;
      attributes["langfuse.observation.prompt.version"] = this.#prompt.version;
    }
    return mappedSpan(span, attributes);
  }
}
