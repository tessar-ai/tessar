import type { PoolClient } from "pg";
import {
  canonicalJson,
  immutable,
  checkpointSafety,
  type Checkpoint,
  type MessageData,
  type RecordKind,
} from "@tessar/core";
import type { Database } from "./database.js";
export type VersionTable = RecordKind | "messages";

export async function writeVersions(
  db: Database,
  client: PoolClient,
  name: VersionTable,
  threadId: string,
  revision: number,
  entries: readonly { id: string; data: unknown; position?: number }[],
  replace = false,
): Promise<void> {
  const table = db.table(name);
  const { rows } = await client.query(
    `SELECT id,body,position FROM ${table} WHERE thread_id=$1 AND to_revision IS NULL`,
    [threadId],
  );
  const current = new Map(rows.map((row) => [row.id, row]));
  for (const entry of entries) {
    const old = current.get(entry.id);
    current.delete(entry.id);
    const body = canonicalJson(entry.data);
    if (
      old &&
      canonicalJson(old.body) === body &&
      old.position === (entry.position ?? null)
    )
      continue;
    if (old)
      await client.query(
        `UPDATE ${table} SET to_revision=$1 WHERE thread_id=$2 AND id=$3 AND to_revision IS NULL`,
        [revision, threadId, entry.id],
      );
    const value = entry.data as Record<string, unknown>;
    await client.query(
      `INSERT INTO ${table}(thread_id,id,from_revision,position,stream_id,turn_id,status,sort_date,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        threadId,
        entry.id,
        revision,
        entry.position ?? null,
        value.streamId ?? null,
        value.turnId ?? null,
        value.status ?? null,
        value.createdAt ?? value.startedAt ?? "",
        body,
      ],
    );
  }
  if (replace && current.size)
    await client.query(
      `UPDATE ${table} SET to_revision=$1 WHERE thread_id=$2 AND id=ANY($3::text[]) AND to_revision IS NULL`,
      [revision, threadId, [...current.keys()]],
    );
}
export async function readVersions<T>(
  db: Database,
  client: PoolClient,
  name: VersionTable,
  threadId: string,
  revision: number,
): Promise<T[]> {
  const { rows } = await client.query(
    `SELECT body FROM ${db.table(name)} WHERE thread_id=$1 AND from_revision<=$2 AND (to_revision IS NULL OR $2<to_revision) ORDER BY ${name === "messages" ? "position" : 'sort_date,id COLLATE "C"'}`,
    [threadId, revision],
  );
  return rows.map((row) => immutable(row.body) as T);
}
export async function writeCheckpoint(
  db: Database,
  client: PoolClient,
  cp: Checkpoint,
): Promise<void> {
  await writeVersions(
    db,
    client,
    "messages",
    cp.threadId,
    cp.revision,
    cp.state.messages.map((data, position) => ({
      id: data.id,
      data,
      position,
    })),
    true,
  );
  const { messages, ...state } = cp.state,
    safety = checkpointSafety(cp);
  await client.query(
    `INSERT INTO ${db.table("checkpoints")}(id,thread_id,revision,created_at,cause,message_count,forkable,unsafe_reason,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      cp.id,
      cp.threadId,
      cp.revision,
      cp.createdAt,
      cp.cause,
      messages.length,
      safety.forkable,
      safety.unsafeReason,
      canonicalJson({ ...cp, state }),
    ],
  );
}
export async function hydrate(
  db: Database,
  client: PoolClient,
  cp: Checkpoint,
): Promise<Checkpoint> {
  return immutable({
    ...cp,
    state: {
      ...cp.state,
      messages: await readVersions<MessageData>(
        db,
        client,
        "messages",
        cp.threadId,
        cp.revision,
      ),
    },
  });
}
