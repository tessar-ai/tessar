import type { PoolClient } from "pg";
import {
  canonicalJson,
  buildThreadInfo,
  recordBinding,
  validateSession,
  commitFingerprint,
  validateBatch,
  fail,
  immutable,
  matchesScope,
  historyCursor,
  limitOf,
  encodeCursor,
  type SessionRecord,
  type CommitBatch,
  type CommitReceipt,
  type StorageBackend,
  type ThreadInfo,
  type Checkpoint,
  type RecordKind,
  type RecordTypes,
  type PluginStateSnapshot,
  type MessageData,
} from "@tessar/core";
import { openDatabase, type PostgresqlStorageOptions } from "./database.js";
import { initializeSchema, recordTables } from "./schema.js";
import { createRecordStore } from "./records.js";
import { assertOwnership, createOwnership } from "./ownership.js";
import { page, scopeFilter } from "./queries.js";
import {
  readVersions,
  writeVersions,
  writeCheckpoint,
  hydrate,
} from "./versions.js";
export type { PostgresqlStorageOptions } from "./database.js";

export async function createPostgresqlBackend(
  options: PostgresqlStorageOptions,
): Promise<StorageBackend> {
  const db = openDatabase(options),
    table = db.table;
  try {
    await initializeSchema(db);
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
  const get = async <T>(
    client: PoolClient,
    sql: string,
    values: unknown[],
  ): Promise<T | null> => {
    const { rows } = await client.query(sql, values);
    return rows[0] ? (immutable(rows[0].body) as T) : null;
  };
  const head = (client: PoolClient, id: string) =>
    get<ThreadInfo>(
      client,
      `SELECT body FROM ${table("threads")} WHERE id=$1`,
      [id],
    );
  const checkpoint = (client: PoolClient, id: string) =>
    get<Checkpoint>(
      client,
      `SELECT body FROM ${table("checkpoints")} WHERE id=$1`,
      [id],
    );
  const checkKind = (kind: RecordKind) => {
    if (!recordTables.includes(kind))
      fail("InvalidConfiguration", "Unknown record kind");
  };
  const records = async <K extends RecordKind>(
    client: PoolClient,
    kind: K,
    threadId: string,
    checkpointId?: string,
  ): Promise<RecordTypes[K][]> => {
    checkKind(kind);
    const cp = await checkpoint(
      client,
      checkpointId ?? (await head(client, threadId))?.currentCheckpointId ?? "",
    );
    return cp?.threadId === threadId
      ? readVersions<RecordTypes[K]>(db, client, kind, threadId, cp.revision)
      : [];
  };
  const ownerKey = (
    key: Pick<
      PluginStateSnapshot,
      "ownerType" | "ownerId" | "pluginId" | "namespace"
    >,
  ) => canonicalJson([key.ownerType, key.ownerId, key.pluginId, key.namespace]);

  return {
    records: createRecordStore(db),
    id: "postgresql",
    capabilities: {
      durable: true,
      atomicPublish: true,
      coordination: "multi-process",
    },
    close: db.close,
    sessions: {
      get: (id, query = {}) =>
        db.transaction(async (client) => {
          const value = await get<SessionRecord>(
            client,
            `SELECT body FROM ${table("sessions")} WHERE id=$1`,
            [id],
          );
          return value && matchesScope(value.scope, query.scope) ? value : null;
        }),
      page: (query) =>
        db.transaction(async (client) => {
          const values: unknown[] = [query.agentId];
          return page<SessionRecord>(
            client,
            table("sessions"),
            "agent_id=$1 AND " + scopeFilter(query.scope, values),
            values,
            query,
            canonicalJson({ agentId: query.agentId, scope: query.scope ?? {} }),
            "created_at",
          );
        }),
      compareAndSet: async (value, expected) => {
        value = immutable(value);
        return db.transaction(
          async (client) => {
            const old = await get<SessionRecord>(
              client,
              `SELECT body FROM ${table("sessions")} WHERE id=$1 FOR UPDATE`,
              [value.id],
            );
            validateSession(
              value,
              old,
              expected,
              value.selectedThreadId
                ? await head(client, value.selectedThreadId)
                : null,
            );
            await client.query(
              `INSERT INTO ${table("sessions")}(id,agent_id,selected_thread_id,revision,created_at,updated_at,body) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET selected_thread_id=excluded.selected_thread_id,revision=excluded.revision,updated_at=excluded.updated_at,body=excluded.body`,
              [
                value.id,
                value.agentId,
                value.selectedThreadId,
                value.revision,
                value.createdAt,
                value.updatedAt,
                canonicalJson(value),
              ],
            );
          },
          [
            "session:" + value.id,
            ...(value.selectedThreadId
              ? ["thread:" + value.selectedThreadId]
              : []),
          ],
        );
      },
    },
    ownedState: {
      get: (key) =>
        db.transaction((client) =>
          get<PluginStateSnapshot>(
            client,
            `SELECT body FROM ${table("owned_states")} WHERE owner_key=$1`,
            [ownerKey(key)],
          ),
        ),
      compareAndSet: async (state, expected) => {
        state = immutable(state);
        return db.transaction(
          async (client) => {
            if (!["agent", "session"].includes(state.ownerType))
              fail(
                "InvalidConfiguration",
                "Execution state must use checkpoints",
              );
            const key = ownerKey(state),
              old = await get<PluginStateSnapshot>(
                client,
                `SELECT body FROM ${table("owned_states")} WHERE owner_key=$1`,
                [key],
              );
            if (
              (old?.revision ?? 0) !== expected ||
              state.revision !== expected + 1
            )
              fail("CommitConflict", "Owned state revision changed");
            await client.query(
              `INSERT INTO ${table("owned_states")}(owner_key,revision,body) VALUES($1,$2,$3) ON CONFLICT(owner_key) DO UPDATE SET revision=excluded.revision,body=excluded.body`,
              [key, state.revision, canonicalJson(state)],
            );
          },
          ["owned:" + ownerKey(state)],
        );
      },
    },
    threads: {
      get: (id, options) =>
        db.transaction(async (client) => {
          const value = await head(client, id);
          return value && (!value.deleted || options?.includeDeleted)
            ? value
            : null;
        }),
      page: (query) =>
        db.transaction(async (client) => {
          const values: unknown[] = [];
          return page<ThreadInfo>(
            client,
            table("threads"),
            "deleted=FALSE AND " + scopeFilter(query.scope, values),
            values,
            query,
            canonicalJson(query.scope ?? {}),
            "created_at",
          );
        }),
      list: (query = {}) =>
        db.transaction(async (client) => {
          const values: unknown[] = [],
            where = scopeFilter(query.scope, values);
          return (
            await client.query(
              `SELECT body FROM ${table("threads")} WHERE deleted=FALSE AND ${where} ORDER BY created_at,id COLLATE "C"`,
              values,
            )
          ).rows.map((row) => immutable(row.body) as ThreadInfo);
        }),
      purge: (id, query = {}) =>
        db.transaction(
          async (client) => {
            const info = await head(client, id);
            if (!info || !matchesScope(info.scope, query.scope))
              fail("ThreadNotFound", "Thread does not match query");
            if (!info.deleted)
              fail("ThreadNotDeleted", "Soft-delete the thread before purging");
            const active = await client.query(
              `SELECT 1 FROM ${table("leases")} WHERE thread_id=$1 AND expires_at>clock_timestamp()`,
              [id],
            );
            if (info.activeStreamId || active.rowCount)
              fail("ThreadBusy", "Thread has active execution or ownership");
            const referenced = await client.query(
              `SELECT 1 FROM ${table("threads")} WHERE body->>'parentThreadId'=$1 OR body->>'sourceCheckpointId' IN (SELECT id FROM ${table("checkpoints")} WHERE thread_id=$1) LIMIT 1`,
              [id],
            );
            if (referenced.rowCount)
              fail("ThreadReferenced", "Retained fork references this thread");
            for (const name of [
              ...recordTables,
              "messages",
              "checkpoints",
              "commits",
              "staging",
            ])
              await client.query(
                `DELETE FROM ${table(name)} WHERE thread_id=$1`,
                [id],
              );
            await client.query(`DELETE FROM ${table("threads")} WHERE id=$1`, [
              id,
            ]);
            // Lease tombstones preserve fencing tokens when a purged thread ID is reused.
          },
          ["thread:" + id],
        ),
    },
    checkpoints: {
      get: (id) =>
        db.transaction(async (client) => {
          const cp = await checkpoint(client, id);
          return cp ? hydrate(db, client, cp) : null;
        }),
      list: (threadId) =>
        db.transaction(async (client) => {
          const { rows } = await client.query(
            `SELECT body FROM ${table("checkpoints")} WHERE thread_id=$1 ORDER BY revision`,
            [threadId],
          );
          return Promise.all(rows.map((row) => hydrate(db, client, row.body)));
        }),
      page: (threadId, options) =>
        db.transaction((client) =>
          page(
            client,
            table("checkpoints"),
            "thread_id=$1",
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
              forkable: row.forkable,
              unsafeReason: row.unsafe_reason,
            }),
            "id,revision,created_at,cause,forkable,unsafe_reason",
          ),
        ),
      history: (threadId, options, query = {}) =>
        db.transaction(async (client) => {
          const info = await head(client, threadId);
          if (!info || info.deleted || !matchesScope(info.scope, query.scope))
            fail("ThreadNotFound", "Thread does not match query");
          const { binding, cursor } = historyCursor(threadId, options, query),
            limit = limitOf(options.limit);
          const { rows } = await client.query(
            `SELECT id,revision,message_count FROM ${table("checkpoints")} WHERE thread_id=$1 AND id=$2`,
            [
              threadId,
              cursor?.checkpointId ??
                options.atCheckpointId ??
                info.currentCheckpointId,
            ],
          );
          const cp = rows[0];
          if (!cp) fail("CheckpointNotFound", "No checkpoint for history");
          const end = cursor?.end ?? cp.message_count;
          if (end > cp.message_count)
            fail("InvalidCursor", "Invalid history position");
          const begin = Math.max(0, end - limit);
          const messages = await client.query(
            `SELECT body FROM ${table("messages")} WHERE thread_id=$1 AND position>=$2 AND position<$3 AND from_revision<=$4 AND (to_revision IS NULL OR $4<to_revision) ORDER BY position LIMIT $5`,
            [threadId, begin, end, cp.revision, limit],
          );
          return {
            items: messages.rows.map(
              (row) => immutable(row.body) as MessageData,
            ),
            checkpointId: cp.id,
            revision: cp.revision,
            nextCursor: begin
              ? encodeCursor({ v: 1, binding, checkpointId: cp.id, end: begin })
              : null,
          };
        }),
    },
    executions: {
      listRecords: (kind, threadId, query) =>
        db.transaction((client) =>
          records(client, kind, threadId, query?.atCheckpointId),
        ),
      get: <K extends RecordKind>(
        kind: K,
        id: string,
        query?: { threadId?: string; atCheckpointId?: string },
      ) =>
        db.transaction(async (client) => {
          checkKind(kind);
          const cp = query?.atCheckpointId
            ? await checkpoint(client, query.atCheckpointId)
            : null;
          const threadId = query?.threadId ?? cp?.threadId;
          if (threadId)
            return (
              (
                await records(client, kind, threadId, query?.atCheckpointId)
              ).find((record) => record.id === id) ?? null
            );
          if (query?.atCheckpointId) return null;
          return get<RecordTypes[K]>(
            client,
            `SELECT r.body FROM ${table(kind)} r JOIN ${table("threads")} t ON r.thread_id=t.id WHERE r.id=$1 AND r.to_revision IS NULL AND t.deleted=FALSE ORDER BY r.thread_id LIMIT 1`,
            [id],
          );
        }),
      page: (kind, threadId, query) =>
        db.transaction(async (client) => {
          checkKind(kind);
          const cp = await checkpoint(
            client,
            query.atCheckpointId ??
              (await head(client, threadId))?.currentCheckpointId ??
              "",
          );
          if (!cp || cp.threadId !== threadId)
            fail("CheckpointNotFound", "No checkpoint for records");
          const values: unknown[] = [threadId, cp.revision];
          let where =
            "thread_id=$1 AND from_revision<=$2 AND (to_revision IS NULL OR $2<to_revision)";
          for (const [field, column] of [
            ["streamId", "stream_id"],
            ["turnId", "turn_id"],
            ["status", "status"],
          ] as const)
            if (query[field] !== undefined) {
              values.push(query[field]);
              where += ` AND ${column}=$${values.length}`;
            }
          return page<any>(
            client,
            table(kind),
            where,
            values,
            query,
            recordBinding(kind, threadId, query),
            "sort_date",
          );
        }),
    },
    ownership: createOwnership(db),
    commits: {
      stage: async (batch) => {
        batch = immutable(batch);
        validateBatch(batch);
        const fingerprint = await commitFingerprint(batch);
        await db.transaction(
          async (client) => {
            const prior = await client.query(
              `SELECT fingerprint FROM ${table("commits")} WHERE id=$1 UNION ALL SELECT fingerprint FROM ${table("staging")} WHERE id=$1`,
              [batch.commitId],
            );
            if (prior.rows[0]) {
              if (prior.rows[0].fingerprint !== fingerprint)
                fail("CommitConflict", "commitId payload mismatch");
              return;
            }
            await client.query(
              `INSERT INTO ${table("staging")}(id,thread_id,body,fingerprint) VALUES($1,$2,$3,$4)`,
              [
                batch.commitId,
                batch.threadId,
                canonicalJson(batch),
                fingerprint,
              ],
            );
          },
          ["commit:" + batch.commitId],
        );
      },
      lookupCommit: (id) =>
        db.transaction((client) =>
          get<CommitReceipt>(
            client,
            `SELECT body FROM ${table("commits")} WHERE id=$1`,
            [id],
          ),
        ),
      publish: async (request) => {
        request = immutable(request);
        // Staged payloads cannot change; discover the source to lock both fork threads in order.
        const staged = await db.transaction((client) =>
          get<CommitBatch>(
            client,
            `SELECT body FROM ${table("staging")} WHERE id=$1`,
            [request.commitId],
          ),
        );
        return db.transaction(
          async (client) => {
            const prior = await get<CommitReceipt>(
              client,
              `SELECT body FROM ${table("commits")} WHERE id=$1`,
              [request.commitId],
            );
            if (prior) {
              if (
                prior.threadId !== request.threadId ||
                prior.revision !== request.expectedRevision + 1
              )
                fail("CommitConflict", "Commit request mismatch");
              return prior;
            }
            if (request.lease.threadId !== request.threadId)
              fail("OwnershipLost", "Lease belongs to another thread");
            await assertOwnership(db, client, request.lease);
            const batch = await get<CommitBatch>(
              client,
              `SELECT body FROM ${table("staging")} WHERE id=$1`,
              [request.commitId],
            );
            if (
              !batch ||
              batch.threadId !== request.threadId ||
              batch.expectedRevision !== request.expectedRevision
            )
              fail("CommitConflict", "Missing staged batch");
            if (batch.lineage) {
              // A stage inserted after discovery must be retried with the source lock.
              if (
                staged?.lineage?.parentThreadId !== batch.lineage.parentThreadId
              )
                fail(
                  "CommitConflict",
                  "Fork staging changed; retry publication",
                );
              const parent = await head(client, batch.lineage.parentThreadId),
                source = await checkpoint(
                  client,
                  batch.lineage.sourceCheckpointId,
                );
              if (!parent || parent.deleted || source?.threadId !== parent.id)
                fail("ThreadNotFound", "Fork source is no longer available");
            }
            const old = await head(client, batch.threadId),
              cp = batch.checkpoint;
            if (
              (old?.revision ?? 0) !== batch.expectedRevision ||
              old?.deleted ||
              cp.parentCheckpointId !== (old?.currentCheckpointId ?? null)
            )
              fail("CommitConflict", "Head changed");
            const referenced = async <K extends RecordKind>(
              kind: K,
              id: string,
            ): Promise<RecordTypes[K] | null> => {
              const entry = batch.records.find(
                (record) => record.kind === kind && record.id === id,
              );
              return entry
                ? (entry.data as RecordTypes[K])
                : get<RecordTypes[K]>(
                    client,
                    `SELECT body FROM ${table(kind)} WHERE thread_id=$1 AND id=$2 AND to_revision IS NULL`,
                    [cp.threadId, id],
                  );
            };
            const stream = cp.execution
              ? await referenced("streams", cp.execution.streamId)
              : null;
            if (cp.execution && !stream)
              fail("CommitConflict", "Missing stream reference");
            if (
              cp.execution?.pendingInterruptId &&
              !(await referenced("interrupts", cp.execution.pendingInterruptId))
            )
              fail("CommitConflict", "Missing interrupt reference");
            await writeCheckpoint(db, client, cp);
            for (const kind of recordTables)
              await writeVersions(
                db,
                client,
                kind,
                cp.threadId,
                cp.revision,
                batch.records
                  .filter((entry) => entry.kind === kind)
                  .map((entry) => ({ id: entry.id, data: entry.data })),
              );
            const info = buildThreadInfo(batch, old, stream);
            await client.query(
              `INSERT INTO ${table("threads")}(id,body,created_at,deleted) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET body=excluded.body,created_at=excluded.created_at,deleted=excluded.deleted`,
              [info.id, canonicalJson(info), info.createdAt, info.deleted],
            );
            if (info.deleted)
              await client.query(
                `UPDATE ${table("sessions")} SET selected_thread_id=NULL,revision=revision+1,updated_at=$2,body=body || jsonb_build_object('selectedThreadId',NULL,'revision',revision+1,'updatedAt',$2::text) WHERE selected_thread_id=$1`,
                [info.id, cp.createdAt],
              );
            // Re-check database time after writing: a lease can expire during a long publish.
            await assertOwnership(db, client, request.lease);
            const receipt: CommitReceipt = {
              commitId: batch.commitId,
              threadId: batch.threadId,
              revision: cp.revision,
              checkpointId: cp.id,
            };
            await client.query(
              `INSERT INTO ${table("commits")}(id,thread_id,body,fingerprint) SELECT id,thread_id,$2::jsonb,fingerprint FROM ${table("staging")} WHERE id=$1`,
              [batch.commitId, canonicalJson(receipt)],
            );
            await client.query(`DELETE FROM ${table("staging")} WHERE id=$1`, [
              batch.commitId,
            ]);
            return receipt;
          },
          [
            "commit:" + request.commitId,
            "thread:" + request.threadId,
            ...(staged?.lineage
              ? ["thread:" + staged.lineage.parentThreadId]
              : []),
          ],
        );
      },
    },
  };
}
