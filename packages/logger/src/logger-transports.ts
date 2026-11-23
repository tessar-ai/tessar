import { appendFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { LogEntry } from "./logger.js";

/** A destination for structured log entries, owned and closed by LoggerPlugin. */
export interface LogTransport {
  write(entry: LogEntry): void | Promise<void>;
  close?(): void | Promise<void>;
}

export const logGroup = {
  none: "none",
  thread: "thread",
  session: "session",
  stream: "stream",
} as const;
export type LogGroup = (typeof logGroup)[keyof typeof logGroup];

export interface FileTransportOptions {
  /** Full filename; its parent directory and extension are reused for groups. */
  path: string;
  /** Missing grouping IDs fall back to path. Defaults to logGroup.none. */
  groupBy?: LogGroup;
}

export class ConsoleTransport implements LogTransport {
  write(entry: LogEntry): void {
    console.error(JSON.stringify(entry));
  }
}

/** Encode unsafe characters and case differences for portable, distinct filenames. */
function filename(id: string): string {
  const encoded = encodeURIComponent(id).replace(
    /%[0-9A-F]{2}|[A-Z.!'()*]/g,
    (character) =>
      character.startsWith("%")
        ? character
        : "%" + character.charCodeAt(0).toString(16).toUpperCase(),
  );
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(encoded)
    ? "%" + encoded.charCodeAt(0).toString(16).toUpperCase() + encoded.slice(1)
    : encoded;
}

/** Append JSON Lines, serializing writes so concurrent events cannot interleave. */
export class FileTransport implements LogTransport {
  readonly #path: string;
  readonly #group: LogGroup;
  #pending = Promise.resolve();
  #closed = false;

  constructor(options: FileTransportOptions) {
    if (
      typeof options.path !== "string" ||
      !options.path.trim() ||
      /[\\/]$/.test(options.path) ||
      [".", ".."].includes(basename(options.path))
    )
      throw new Error("FileTransport path must name a file");
    this.#path = resolve(options.path);
    this.#group = options.groupBy ?? logGroup.none;
    if (!Object.values(logGroup).includes(this.#group))
      throw new Error("Invalid FileTransport groupBy");
  }

  write(entry: LogEntry): Promise<void> {
    if (this.#closed)
      return Promise.reject(new Error("FileTransport is closed"));
    let path = this.#path;
    const directory = dirname(path),
      extension = extname(path);
    if (this.#group === logGroup.thread && entry.threadId)
      path = join(directory, "threads", filename(entry.threadId) + extension);
    else if (
      this.#group === logGroup.session &&
      entry.sessionId &&
      entry.threadId
    )
      path = join(
        directory,
        "sessions",
        filename(entry.sessionId),
        filename(entry.threadId) + extension,
      );
    else if (this.#group === logGroup.stream && entry.streamId)
      path = join(directory, "streams", filename(entry.streamId) + extension);
    const line = JSON.stringify(entry) + "\n";
    // ponytail: one queue per transport; per-file queues if disk throughput requires it.
    const writing = this.#pending.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line, "utf8");
    });
    // A failed write is reported to its caller without blocking subsequent entries.
    this.#pending = writing.catch(() => {});
    return writing;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#pending;
  }
}
