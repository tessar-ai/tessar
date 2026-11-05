import { fail } from "../errors.js";
import { canonicalJson } from "./commit.js";
import { MessageCodec } from "../messages/codec.js";
import type { Message } from "../messages/message.js";
import type { StorageBackend } from "./storage-ports.js";
import type {
  Checkpoint,
  HistoryOptions,
  CheckpointInfo,
  RecordQuery,
  Page,
  PageOptions,
  StateQuery,
  ThreadInfo,
  RecordKind,
  RecordTypes,
} from "./schema.js";
import { matchesScope } from "./scope.js";

const INVALID_CURSOR = "InvalidCursor";
export type { HistoryOptions, CheckpointInfo } from "./schema.js";
export interface HistoryPage extends Page<Message> {
  checkpointId: string;
  revision: number;
}
export function checkpointSafety(cp: Checkpoint): {
  forkable: boolean;
  unsafeReason: string | null;
} {
  const pending = new Set<string>();
  for (const message of cp.state.messages) {
    for (const part of message.content)
      if (part.type === "tool-call") pending.add(part.toolCallId);
    if (message.role === "tool") pending.delete(message.toolCallId!);
  }
  return pending.size
    ? { forkable: false, unsafeReason: "UnresolvedToolCalls" }
    : { forkable: true, unsafeReason: null };
}
export function limitOf(limit = 50): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    fail("InvalidConfiguration", "Page limit must be 1..200");
  return limit;
}
export function encodeCursor(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}
export function decodeCursor(value: string): any {
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    fail(INVALID_CURSOR, "Malformed cursor");
  }
}
export function compareOrdinal(a: string, b: string): number {
  const x = new TextEncoder().encode(a),
    y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
export function pageAfter(
  options: PageOptions,
  binding: string,
): [string, string] | null {
  if (!options.cursor) return null;
  const cursor = decodeCursor(options.cursor);
  if (
    !cursor ||
    cursor.v !== 2 ||
    cursor.binding !== binding ||
    !Array.isArray(cursor.after) ||
    cursor.after.length !== 2 ||
    cursor.after.some((v: unknown) => typeof v !== "string")
  )
    fail(INVALID_CURSOR, "Cursor belongs to another query");
  return cursor.after;
}
export function pageRows<T extends { id: string }>(
  rows: readonly T[],
  options: PageOptions = {},
  binding = "",
): Page<T> {
  const key = (row: T): [string, string] => [
    (row as T & { createdAt?: string; startedAt?: string }).createdAt ??
    (row as T & { startedAt?: string }).startedAt ??
    "",
    row.id,
  ];
  const compare = (a: [string, string], b: [string, string]) =>
    compareOrdinal(a[0], b[0]) || compareOrdinal(a[1], b[1]);
  const limit = limitOf(options.limit),
    after = pageAfter(options, binding);
  const sorted = rows
    .filter((row) => !after || compare(key(row), after) > 0)
    .sort((a, b) => compare(key(a), key(b)));
  const items = sorted.slice(0, limit);
  return {
    items,
    nextCursor:
      sorted.length > limit
        ? encodeCursor({ v: 2, binding, after: key(items.at(-1)!) })
        : null,
  };
}
export function recordBinding(
  kind: RecordKind,
  threadId: string,
  query: RecordQuery,
): string {
  return canonicalJson({
    kind,
    threadId,
    streamId: query.streamId ?? null,
    turnId: query.turnId ?? null,
    status: query.status ?? null,
    checkpointId: query.atCheckpointId ?? null,
  });
}
export function historyCursor(
  id: string,
  options: HistoryOptions,
  query: StateQuery,
) {
  const binding = canonicalJson({ threadId: id, scope: query.scope ?? {} });
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  if (
    options.cursor &&
    (!cursor ||
      cursor.v !== 1 ||
      cursor.binding !== binding ||
      typeof cursor.checkpointId !== "string" ||
      !Number.isInteger(cursor.end) ||
      cursor.end < 0 ||
      (options.atCheckpointId &&
        options.atCheckpointId !== cursor.checkpointId))
  )
    fail(INVALID_CURSOR, "History cursor mismatch");
  return {
    binding,
    cursor: cursor as { checkpointId: string; end: number } | null,
  };
}
export class StateQueries {
  constructor(readonly backend: StorageBackend) { }
  async getThread(
    id: string,
    query: StateQuery = {},
  ): Promise<ThreadInfo | null> {
    const info = await this.backend.threads.get(id);
    return info && matchesScope(info.scope, query.scope) ? info : null;
  }
  async requireThread(id: string, query: StateQuery = {}): Promise<ThreadInfo> {
    const info = await this.getThread(id, query);
    if (!info) fail("ThreadNotFound", "Thread does not match query");
    return info;
  }
  async listThreads(
    query: StateQuery & PageOptions = {},
  ): Promise<Page<ThreadInfo>> {
    return this.backend.threads.page(query);
  }

  async snapshot(id: string, query: StateQuery = {}): Promise<Checkpoint> {
    const info = await this.requireThread(id, query);
    return (await this.backend.checkpoints.get(info.currentCheckpointId))!;
  }
  async getHistory(
    id: string,
    options: HistoryOptions = {},
    query: StateQuery = {},
  ): Promise<HistoryPage> {
    await this.requireThread(id, query);
    const page = await this.backend.checkpoints.history(id, options, query);
    return {
      ...page,
      items: Object.freeze(
        page.items.map((message) => MessageCodec.decode(message)),
      ),
    };
  }

  async getCheckpoint(
    threadId: string,
    id: string,
    query: StateQuery = {},
  ): Promise<Checkpoint | null> {
    await this.requireThread(threadId, query);
    const cp = await this.backend.checkpoints.get(id);
    return cp?.threadId === threadId ? cp : null;
  }
  async listCheckpoints(
    threadId: string,
    options: PageOptions = {},
    query: StateQuery = {},
  ): Promise<Page<CheckpointInfo>> {
    await this.requireThread(threadId, query);
    return this.backend.checkpoints.page(threadId, options);
  }

  async getRecord<K extends RecordKind>(
    kind: K,
    threadId: string,
    id: string,
    query: StateQuery = {},
  ): Promise<RecordTypes[K] | null> {
    await this.requireThread(threadId, query);
    return this.backend.executions.get(kind, id, { threadId });
  }
  async listRecords<K extends RecordKind>(
    kind: K,
    threadId: string,
    options: RecordQuery = {},
    query: StateQuery = {},
  ): Promise<Page<RecordTypes[K]>> {
    await this.requireThread(threadId, query);
    return this.backend.executions.page(kind, threadId, options);
  }
}
