import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { mappedSpan } from "../attributes.js";
import { openLLMetryAttributes } from "./openllmetry.js";
import { OTLPAdapter } from "./otlp.js";

export interface TraceloopOptions {
  apiKey?: string;
  /** Full OTLP/HTTP trace URL; otherwise uses TRACELOOP_BASE_URL plus /v1/traces. */
  endpoint?: string;
}

/** Traceloop authentication and OpenLLMetry compatibility fields. */
export class TraceloopAdapter extends OTLPAdapter {
  constructor(options: TraceloopOptions = {}) {
    const apiKey = options.apiKey ?? process.env.TRACELOOP_API_KEY;
    if (!apiKey) throw Error("Traceloop requires apiKey or TRACELOOP_API_KEY");
    const base = (
      process.env.TRACELOOP_BASE_URL ?? "https://api.traceloop.com"
    ).replace(/\/+$/, "");
    super({
      endpoint: options.endpoint ?? base + "/v1/traces",
      headers: { Authorization: "Bearer " + apiKey },
    });
  }
  protected override mapSpan(span: ReadableSpan): ReadableSpan {
    return mappedSpan(span, openLLMetryAttributes(span));
  }
}
