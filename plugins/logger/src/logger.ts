import { createRequire } from "node:module";
import type { EventContext, Plugin, PluginContext } from "@tessar/core";

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry extends EventContext {
  level: LogLevel;
  type: string;
  timestamp: string;
  payload: unknown;
}

export interface LogTransport {
  write(entry: LogEntry): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface LoggerOptions {
  /** Minimum level sent to transports. Defaults to info. */
  level?: LogLevel;
  /** Defaults to a ConsoleTransport writing JSON to stderr. */
  transports?: readonly LogTransport[];
}

export type LogGroup = "none" | "thread" | "session" | "stream";
export interface FileTransportOptions {
  /** Full filename; its parent directory and extension are reused for groups. */
  path: string;
  /** Missing grouping IDs fall back to path. Defaults to logGroup.none. */
  groupBy?: LogGroup;
}

export interface LoggerPlugin extends Plugin {
  readonly id: "logger";
  setup(tessar: PluginContext): void;
}

export interface ConsoleTransport extends LogTransport {
  write(entry: LogEntry): void;
}

export interface FileTransport extends LogTransport {
  write(entry: LogEntry): Promise<void>;
  close(): Promise<void>;
}

const addon: {
  LoggerPlugin: new (options?: LoggerOptions) => LoggerPlugin;
  ConsoleTransport: new () => ConsoleTransport;
  FileTransport: new (options: FileTransportOptions) => FileTransport;
  logGroups(): { readonly [Group in LogGroup]: Group };
} = createRequire(import.meta.url)(`./bin/${process.platform}-${process.arch}.node`);

export const { LoggerPlugin, ConsoleTransport, FileTransport } = addon;
export const logGroup = addon.logGroups();
export default new LoggerPlugin();
