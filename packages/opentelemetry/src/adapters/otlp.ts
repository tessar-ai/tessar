import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { TraceAdapter } from "../types.js";

export interface OTLPOptions {
  /** Full OTLP/HTTP trace URL, including /v1/traces. Otherwise uses SDK environment/defaults. */
  endpoint?: string;
  headers?: Readonly<Record<string, string>>;
}

class MappedExporter implements SpanExporter {
  constructor(
    private readonly exporter: SpanExporter,
    private readonly map: (span: ReadableSpan) => ReadableSpan,
  ) {}
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    try {
      this.exporter.export(spans.map(this.map), done);
    } catch (error) {
      done({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : Error(String(error)),
      });
    }
  }
  shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.() ?? Promise.resolve();
  }
}

/** Standard OTLP/HTTP JSON export, for compatible receivers and collectors. */
export class OTLPAdapter implements TraceAdapter {
  readonly #options: OTLPOptions;
  constructor(options: OTLPOptions = {}) {
    if (
      options.endpoint &&
      !["http:", "https:"].includes(new URL(options.endpoint).protocol)
    )
      throw Error("OTLP endpoint must use HTTP or HTTPS");
    this.#options = {
      ...options,
      headers: options.headers ? { ...options.headers } : undefined,
    };
  }
  protected mapSpan(span: ReadableSpan): ReadableSpan {
    return span;
  }
  createExporter(): SpanExporter {
    return new MappedExporter(
      new OTLPTraceExporter({
        url: this.#options.endpoint,
        headers: this.#options.headers,
      }),
      (span) => this.mapSpan(span),
    );
  }
}
