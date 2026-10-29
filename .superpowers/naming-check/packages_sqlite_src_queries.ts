import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  normalizeScope,
  immutable,
  fail,
  pageAfter,
  limitOf,
  encodeCursor,
  historyCursor,
  matchesScope,
  type PageOptions,
  type Page,
  type Scope,
  type ThreadInfo,
  type HistoryOptions,
  type HistoryDataPage,
  type StateQuery,
  type CheckpointInfo,
  type MessageData,
} from "@tessar/core";

/** Values and keys are parameters, including keys containing JSON-path punctuation. */
export function scopePredicate(
  scope: Scope = {},
  column = "body",
): { sql: string; values: SQLInputValue[] } {
  normalizeScope(scope);
  const values: SQLInputValue[] = [];
  const parts = Object.entries(scope).map(([key, value]) => {
    values.push(key);
    if (typeof value === "boolean") {
      values.push(value ? "true" : "false");
      return `EXISTS(SELECT 1 FROM json_each(json_extract(${column},'$.scope')) s WHERE s.key=? AND s.type=?)`;
    }
    values.push(value);
    return `EXISTS(SELECT 1 FROM json_each(json_extract(${column},'$.scope')) s WHERE s.key=? AND s.type ${typeof value === "number" ? "IN ('integer','real')" : "='text'"} AND s.value=?)`;
  });
  return { sql: parts.length ? parts.join(" AND ") : "1", values };
}

export function sqlPage<T>(
  db: DatabaseSync,
  table: string,
  where: string,
  values: SQLInputValue[],
  options: PageOptions,
  binding: string,
  dateColumn: string,
  map: (row: Record<string, any>) => T = (row) =>
    immutable(JSON.parse(row.body)),
  columns = "*",
): Page<T> {
  const after = pageAfter(options, binding),
    limit = limitOf(options.limit);
  const filter = after
    ? ` AND (${dateColumn}>? OR (${dateColumn}=? AND id COLLATE BINARY>?))`
    : "";
  const rows = db
    .prepare(
      `SELECT ${columns},${dateColumn} AS page_date FROM ${table} WHERE ${where}${filter} ORDER BY ${dateColumn},id COLLATE BINARY LIMIT ?`,
    )
    .all(
      ...values,
      ...(after ? [after[0], after[0], after[1]] : []),
      limit + 1,
    ) as Record<string, any>[];
  const selected = rows.slice(0, limit),
    last = selected.at(-1);
  return {
    items: selected.map(map),
    nextCursor:
      rows.length > limit
        ? encodeCursor({ v: 2, binding, after: [last!.page_date, last!.id] })
        : null,
  };
}

export function historyPage(
  db: DatabaseSync,
  id: string,
  options: HistoryOptions,
  query: StateQuery = {},
): HistoryDataPage {
  const row = db
    .prepare("SELECT body FROM threads WHERE id=? AND deleted=0")
    .get(id);
  const head = row ? (JSON.parse(String(row.body)) as ThreadInfo) : null;
  if (!head || !matchesScope(head.scope, query.scope))
    fail("ThreadNotFound", "Thread does not match query");
  const { binding, cursor } = historyCursor(id, options, query),
    limit = limitOf(options.limit);
  const cp = db
    .prepare(
      "SELECT id,revision,message_count FROM checkpoints WHERE thread_id=? AND id=?",
    )
    .get(
      id,
      cursor?.checkpointId ??
        options.atCheckpointId ??
        head.currentCheckpointId,
    );
  if (!cp) fail("CheckpointNotFound", "No checkpoint for history");
  const end = cursor?.end ?? Number(cp.message_count);
  if (end > Number(cp.message_count))
    fail("InvalidCursor", "Invalid history position");
  const begin = Math.max(0, end - limit),
    revision = Number(cp.revision);
  const items = db
    .prepare(
      "SELECT body FROM messages WHERE thread_id=? AND position>=? AND position<? AND from_revision<=? AND (to_revision IS NULL OR ?<to_revision) ORDER BY position LIMIT ?",
    )
    .all(id, begin, end, revision, revision, limit)
    .map((row) => immutable(JSON.parse(String(row.body))) as MessageData);
  return {
    items,
    checkpointId: String(cp.id),
    revision,
    nextCursor: begin
      ? encodeCursor({ v: 1, binding, checkpointId: cp.id, end: begin })
      : null,
  };
}

export function checkpointPage(
  db: DatabaseSync,
  threadId: string,
  options: PageOptions,
): Page<CheckpointInfo> {
  return sqlPage(
    db,
    "checkpoints",
    "thread_id=?",
    [threadId],
    options,
    "checkpoints:" + threadId,
    "created_at",
    (row) => ({
      id: row.id,
      threadId,
      revision: row.revision,
      createdAt: row.created_at,
      cause: row.cause,
      forkable: !!row.forkable,
      unsafeReason: row.unsafe_reason,
    }),
    "id,revision,created_at,cause,forkable,unsafe_reason",
  );
}
