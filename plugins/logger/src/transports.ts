import { mkdir, open } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { LogEntry } from "./logger.js";

const MAX_BATCH_ENTRIES = 32;
const MAX_BATCH_BYTES = 256 * 1024;
const FILE_APPEND_MODE = "a";

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

interface FileWrite {
  path: string;
  line: Buffer;
  resolve(): void;
  reject(error: unknown): void;
  next?: FileWrite;
}

/** Append queued JSON Lines in order, batching consecutive writes to one file. */
export class FileTransport implements LogTransport {
  readonly #path: string;
  readonly #group: LogGroup;
  #head?: FileWrite;
  #tail?: FileWrite;
  #pending?: Promise<void>;
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
    const line = Buffer.from(JSON.stringify(entry) + "\n");
    return new Promise<void>((resolve, reject) => {
      const write = { path, line, resolve, reject };
      if (this.#tail) this.#tail.next = write;
      else this.#head = write;
      this.#tail = write;
      this.#pending ??= Promise.resolve().then(() => this.#drain());
    });
  }

  async #drain(): Promise<void> {
    while (this.#head) {
      const first = this.#head;
      const batch = [first];
      let last = first;
      let size = first.line.length;
      while (
        last.next?.path === first.path && batch.length < MAX_BATCH_ENTRIES &&
        size + last.next.line.length <= MAX_BATCH_BYTES
      ) {
        last = last.next;
        batch.push(last);
        size += last.line.length;
      }
      this.#head = last.next;
      last.next = undefined;
      if (!this.#head) this.#tail = undefined;

      let written = 0;
      let failure: unknown;
      try {
        const bytes = batch.length === 1
          ? first.line
          : Buffer.concat(batch.map(write => write.line), size);
        await mkdir(dirname(first.path), { recursive: true });
        const file = await open(first.path, FILE_APPEND_MODE);
        try {
          while (written < size) {
            const { bytesWritten } = await file.write(bytes, written, size - written);
            if (bytesWritten === 0) throw new Error("Failed to write log batch");
            written += bytesWritten;
          }
        } finally {
          await file.close();
        }
      } catch (error) {
        failure = error;
      }

      let end = 0;
      for (const write of batch) {
        end += write.line.length;
        if (end <= written) write.resolve();
        else write.reject(failure);
      }
    }
    this.#pending = undefined;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#pending;
  }
}
