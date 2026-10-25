import type { Plugin, PluginContext } from "@tessar/core";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { OpenTelemetryOptions } from "./types.js";
import { createTracing } from "./trace.js";
import { registerLifecycleHooks } from "./lifecycle.js";
import { registerModelHooks } from "./models.js";
import { registerToolHooks } from "./tools.js";

/** One shared tracing lifecycle with independently mapped export destinations. */
export class OpenTelemetryPlugin implements Plugin {
  readonly id = "opentelemetry";
  readonly #options: OpenTelemetryOptions;

  constructor(options: OpenTelemetryOptions) {
    if (!Array.isArray(options?.adapters) || !options.adapters.length)
      throw Error("OpenTelemetry requires at least one trace adapter");
    if (
      options.adapters.some(
        (adapter) => !adapter || typeof adapter.createExporter !== "function",
      )
    )
      throw Error("A trace adapter must implement createExporter()");
    this.#options = {
      ...options,
      adapters: [...options.adapters],
      tags: options.tags?.slice(),
    };
  }

  async setup(tessar: PluginContext): Promise<void> {
    const processors: SpanProcessor[] = [];
    const Processor = this.#options.realtime
      ? SimpleSpanProcessor
      : BatchSpanProcessor;
    try {
      for (const adapter of this.#options.adapters)
        processors.push(new Processor(adapter.createExporter()));
      const tracing = createTracing(this.#options, processors);
      registerLifecycleHooks(tessar, tracing);
      registerModelHooks(tessar, tracing);
      registerToolHooks(tessar, tracing);
    } catch (error) {
      await Promise.allSettled(
        processors.map((processor) => processor.shutdown()),
      );
      throw error;
    }
  }
}
