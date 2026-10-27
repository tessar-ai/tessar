import {
  ready as readyHooks,
  shutdown as shutdownHooks,
  thread as threadHooks,
  stream as streamHooks,
  turn as turnHooks,
  model as modelHooks,
  tool as toolHooks,
  diagnostic as diagnosticHooks,
  session as sessionHooks,
  input as inputHooks,
  text,
  reasoning,
} from "@tessar/core";
import {
  type EventContext,
  type Plugin,
  type PluginContext,
} from "@tessar/core";
import { ConsoleTransport, type LogTransport } from "./logger-transports.js";
export {
  ConsoleTransport,
  FileTransport,
  logGroup,
  type LogTransport,
  type LogGroup,
  type FileTransportOptions,
} from "./logger-transports.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry extends EventContext {
  level: LogLevel;
  type: string;
  timestamp: string;
  payload: unknown;
}
export interface LoggerOptions {
  /** Minimum level sent to transports. Defaults to info. */
  level?: LogLevel;
  /** Defaults to a ConsoleTransport writing JSON to stderr. */
  transports?: readonly LogTransport[];
}
const ranks: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const debugEvents = new Set<string>([
  inputHooks.received,
  text.delta,
  reasoning.delta,
  toolHooks.update,
  modelHooks.usage,
]);
const events = [
  readyHooks,
  threadHooks.started,
  threadHooks.forked,
  threadHooks.renamed,
  threadHooks.deleted,
  streamHooks.started,
  streamHooks.end,
  streamHooks.error,
  streamHooks.suspended,
  streamHooks.resumed,
  streamHooks.cancel,
  turnHooks.start,
  turnHooks.end,
  text.start,
  text.end,
  reasoning.start,
  reasoning.end,
  toolHooks.call.start,
  toolHooks.call.end,
  modelHooks.start,
  modelHooks.end,
  modelHooks.error,
  toolHooks.start,
  toolHooks.end,
  toolHooks.error,
  diagnosticHooks,
  sessionHooks.created,
  sessionHooks.modelChanged,
  sessionHooks.model.optionsChanged,
  sessionHooks.threadSwitched,
  sessionHooks.inputQueued,
  sessionHooks.inputDiscarded,
  sessionHooks.closed,
  inputHooks.received,
  text.delta,
  reasoning.delta,
  toolHooks.update,
  modelHooks.usage,
] as const;

async function settle(
  actions: readonly (() => void | Promise<void>)[],
): Promise<void> {
  const results = await Promise.allSettled(
    actions.map(async (action) => action()),
  );
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(errors, "Logger transport failed");
}

/** Structured logs with configurable severity and independently managed destinations. */
export class LoggerPlugin implements Plugin {
  readonly id = "logger";
  readonly #transports: readonly LogTransport[];
  readonly #level: LogLevel;

  constructor(options: LoggerOptions = {}) {
    this.#level = options.level ?? "info";
    if (!Object.hasOwn(ranks, this.#level))
      throw new Error("Invalid logger level");
    this.#transports = Object.freeze([
      ...(options.transports ?? [new ConsoleTransport()]),
    ]);
    if (
      this.#transports.some(
        (transport) =>
          !transport ||
          typeof transport.write !== "function" ||
          (transport.close !== undefined &&
            typeof transport.close !== "function"),
      )
    )
      throw new Error("Logger transports must implement LogTransport");
  }

  setup(tessar: PluginContext): void {
    const pending = new Set<Promise<void>>();
    // Session notifications can outlive the API call that emitted them.
    tessar.hook(shutdownHooks, async () => {
      while (pending.size) await Promise.allSettled(pending);
    });
    tessar.defer(() =>
      settle(this.#transports.map((transport) => () => transport.close?.())),
    );
    for (const name of events)
      tessar.hook(name, (event) => {
        const level: LogLevel =
          "error" in event.payload && event.payload.error
            ? "error"
            : event.type === streamHooks.suspended
              ? "warn"
              : debugEvents.has(event.type)
                ? "debug"
                : "info";
        if (ranks[level] < ranks[this.#level]) return;
        const entry: LogEntry = Object.freeze({
          ...event,
          timestamp: event.timestamp,
          level,
        });
        const writing = settle(
          this.#transports.map((transport) => () => transport.write(entry)),
        );
        pending.add(writing);
        return writing.finally(() => pending.delete(writing));
      });
  }
}

export default new LoggerPlugin();
