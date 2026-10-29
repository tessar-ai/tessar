import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  immutable,
  checkpointSafety,
  type Checkpoint,
  type MessageData,
  type RecordKind,
} from "@tessar/core";

export const recordTables = [
  "streams",
  "turns",
  "model_attempts",
  "tool_executions",
  "interrupts",
] as const;
export type VersionTable = RecordKind | "messages";
type VersionInput = { id: string; body: string; position?: number };

export function writeVersions(
  db: DatabaseSync,
  table: VersionTable,
  threadId: string,
  revision: number,
  entries: readonly VersionInput[],
  replace = false,
): void {
  const current = new Map(
    (
      db
        .prepare(
          `SELECT id,body,position FROM ${table} WHERE thread_id=? AND to_revision IS NULL`,
        )
        .all(threadId) as {
        id: string;
        body: string;
        position: number | null;
      }[]
    ).map((row) => [row.id, row]),
  );
  for (const entry of entries) {
    const old = current.get(entry.id);
    current.delete(entry.id);
    if (
      old &&
      old.body === entry.body &&
      old.position === (entry.position ?? null)
    )
      continue;
    if (old)
      db.prepare(
        `UPDATE ${table} SET to_revision=? WHERE thread_id=? AND id=? AND to_revision IS NULL`,
      ).run(revision, threadId, entry.id);
    const value = JSON.parse(entry.body);
    db.prepare(
      `INSERT INTO ${table}(thread_id,id,from_revision,to_revision,position,stream_id,turn_id,status,sort_date,body) VALUES(?,?,?,NULL,?,?,?,?,?,?)`,
    ).run(
      threadId,
      entry.id,
      revision,
      entry.position ?? null,
      value.streamId ?? null,
      value.turnId ?? null,
      value.status ?? null,
      value.createdAt ?? value.startedAt ?? "",
      entry.body,
    );
  }
  if (replace)
    for (const id of current.keys())
      db.prepare(
        `UPDATE ${table} SET to_revision=? WHERE thread_id=? AND id=? AND to_revision IS NULL`,
      ).run(revision, threadId, id);
}

export function readVersions<T>(
  db: DatabaseSync,
  table: VersionTable,
  threadId: string,
  revision: number,
): T[] {
  return (
    db
      .prepare(
        `SELECT body FROM ${table} WHERE thread_id=? AND from_revision<=? AND (to_revision IS NULL OR ?<to_revision) ORDER BY ${table === "messages" ? "position" : "sort_date,id COLLATE BINARY"}`,
      )
      .all(threadId, revision, revision) as { body: string }[]
  ).map((row) => immutable(JSON.parse(row.body)) as T);
}

export function writeCheckpoint(db: DatabaseSync, cp: Checkpoint): void {
  writeVersions(
    db,
    "messages",
    cp.threadId,
    cp.revision,
    cp.state.messages.map((message, position) => ({
      id: message.id,
      position,
      body: canonicalJson(message),
    })),
    true,
  );
  const { messages, ...state } = cp.state;
  const safety = checkpointSafety(cp);
  db.prepare(
    "INSERT INTO checkpoints(id,thread_id,revision,created_at,cause,message_count,forkable,unsafe_reason,body) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    cp.id,
    cp.threadId,
    cp.revision,
    cp.createdAt,
    cp.cause,
    messages.length,
    Number(safety.forkable),
    safety.unsafeReason,
    canonicalJson({ ...cp, state }),
  );
}

export function hydrateCheckpoint(db: DatabaseSync, body: string): Checkpoint {
  const cp = JSON.parse(body) as Checkpoint;
  return immutable({
    ...cp,
    state: {
      ...cp.state,
      messages: readVersions<MessageData>(
        db,
        "messages",
        cp.threadId,
        cp.revision,
      ),
    },
  });
}
