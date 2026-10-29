import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  buildThreadInfo,
  recordBinding,
  validateSession,
  type SessionRecord,
  commitFingerprint,
  validateBatch,
  fail,
  immutable,
  matchesScope,
  type CommitBatch,
  type CommitReceipt,
  type StorageBackend,
  type ThreadInfo,
  type RecordKind,
  type RecordTypes,
  type RecordEntry,
  type PluginStateSnapshot,
} from "@tessar/core";
import { initializeSchema, recordTables } from "./schema.js";
import {
  sqlPage,
  scopePredicate,
  historyPage,
  checkpointPage,
} from "./queries.js";
import {
  readVersions,
  writeVersions,
  writeCheckpoint,
  hydrateCheckpoint,
} from "./versions.js";
import {
  databaseNow,
  assertOwnership,
  createOwnership,
  transaction,
} from "./ownership.js";
export interface SqliteStorageOptions {
  filename: string;
}
export async function createSqliteBackend(
  options: SqliteStorageOptions,
): Promise<StorageBackend> {
  const db = new DatabaseSync(options.filename);
  try {
    await initializeSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }
  let closed = false;
  const getJson = <T>(
    sql: string,
    ...values: (string | number)[]
  ): T | null => {
    const row = db.prepare(sql).get(...values) as { body: string } | undefined;
    return row ? (immutable(JSON.parse(row.body)) as T) : null;
  };
  const head = (id: string) =>
    getJson<ThreadInfo>("SELECT body FROM threads WHERE id=?", id);
  const checkpointRow = (id: string) =>
    db
      .prepare("SELECT thread_id,revision,body FROM checkpoints WHERE id=?")
      .get(id) as
      | { thread_id: string; revision: number; body: string }
      | undefined;
  const records = (kind: RecordKind, threadId: string, cp?: string) => {
    const row = checkpointRow(cp ?? head(threadId)?.currentCheckpointId ?? "");
    return row && row.thread_id === threadId
      ? readVersions<any>(db, kind, threadId, row.revision)
      : [];
  };
  const ownerKey = (
    key: Pick<
      PluginStateSnapshot,
      "ownerType" | "ownerId" | "pluginId" | "namespace"
    >,
  ) => canonicalJson([key.ownerType, key.ownerId, key.pluginId, key.namespace]);
  return {
    sessions: {
      get: async (id, query = {}) => {
        const row = getJson<SessionRecord>(
          "SELECT body FROM sessions WHERE id=?",
          id,
        );
        return row && matchesScope(row.scope, query.scope) ? row : null;
      },
      page: async (query) => {
        const scope = scopePredicate(query.scope);
        return sqlPage<SessionRecord>(
          db,
          "sessions",
          "agent_id=? AND " + scope.sql,
          [query.agentId, ...scope.values],
          query,
          canonicalJson({ agentId: query.agentId, scope: query.scope ?? {} }),
          "created_at",
        );
      },
      compareAndSet: async (value, expected) =>
        transaction(db, () => {
          const old = getJson<SessionRecord>(
            "SELECT body FROM sessions WHERE id=?",
            value.id,
          );
          validateSession(
            value,
            old,
            expected,
            value.selectedThreadId ? head(value.selectedThreadId) : null,
          );
          db.prepare(
            "INSERT INTO sessions VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET selected_thread_id=excluded.selected_thread_id,revision=excluded.revision,updated_at=excluded.updated_at,body=excluded.body",
          ).run(
            value.id,
            value.agentId,
            value.selectedThreadId,
            value.revision,
            value.createdAt,
            value.updatedAt,
            canonicalJson(value),
          );
        }),
    },
    id: "sqlite",
    capabilities: {
      durable: true,
      atomicPublish: true,
      coordination: "multi-process",
    },
    threads: {
      purge: async (id, query = {}) =>
        transaction(db, () => {
          const info = head(id);
          if (!info || !matchesScope(info.scope, query.scope))
            fail("ThreadNotFound", "Thread does not match query");
          if (!info.deleted)
            fail("ThreadNotDeleted", "Soft-delete the thread before purging");
          if (
            info.activeStreamId ||
            db
              .prepare(
                "SELECT 1 FROM leases WHERE thread_id=? AND expires_at>?",
              )
              .get(id, databaseNow(db))
          )
            fail("ThreadBusy", "Thread has active execution or ownership");
          if (
            db
              .prepare(
                "SELECT 1 FROM threads WHERE json_extract(body,'$.parentThreadId')=? OR json_extract(body,'$.sourceCheckpointId') IN (SELECT id FROM checkpoints WHERE thread_id=?) LIMIT 1",
              )
              .get(id, id)
          )
            fail("ThreadReferenced", "Retained fork references this thread");
          for (const table of [
            ...recordTables,
            "messages",
            "checkpoints",
            "commits",
          ])
            db.prepare("DELETE FROM " + table + " WHERE thread_id=?").run(id);
          db.prepare(
            "DELETE FROM staging WHERE json_extract(body,'$.threadId')=?",
          ).run(id);
          db.prepare("DELETE FROM threads WHERE id=?").run(id);
        }),
      page: async (query) => {
        const scope = scopePredicate(query.scope);
        return sqlPage<ThreadInfo>(
          db,
          "threads",
          "deleted=0 AND " + scope.sql,
          scope.values,
          query,
          canonicalJson(query.scope ?? {}),
          "created_at",
        );
      },
      get: async (id, options) => {
        const value = head(id);
        return value && (!value.deleted || options?.includeDeleted)
          ? value
          : null;
      },
      list: async (query) =>
        (db.prepare("SELECT body FROM threads").all() as { body: string }[])
          .map((r) => immutable(JSON.parse(r.body)) as ThreadInfo)
          .filter((r) => !r.deleted && matchesScope(r.scope, query?.scope)),
    },
    checkpoints: {
      page: async (threadId, options) => checkpointPage(db, threadId, options),
      history: async (threadId, options, query) =>
        historyPage(db, threadId, options, query),
      get: async (id) =>
        checkpointRow(id)
          ? hydrateCheckpoint(db, checkpointRow(id)!.body)
          : null,
      list: async (threadId) =>
        (
          db
            .prepare(
              "SELECT body FROM checkpoints WHERE thread_id=? ORDER BY revision",
            )
            .all(threadId) as { body: string }[]
        ).map((r) => hydrateCheckpoint(db, r.body)),
    },
    executions: {
      page: async (kind, threadId, query) => {
        if (!recordTables.includes(kind))
          fail("InvalidConfiguration", "Unknown record kind");
        const cp = checkpointRow(
          query.atCheckpointId ?? head(threadId)?.currentCheckpointId ?? "",
        );
        if (!cp || cp.thread_id !== threadId)
          fail("CheckpointNotFound", "No checkpoint for records");
        const values: (string | number)[] = [
          threadId,
          cp.revision,
          cp.revision,
        ];
        let where =
          "thread_id=? AND from_revision<=? AND (to_revision IS NULL OR ?<to_revision)";
        for (const [field, column] of [
          ["streamId", "stream_id"],
          ["turnId", "turn_id"],
          ["status", "status"],
        ] as const)
          if (query[field] !== undefined) {
            where += " AND " + column + "=?";
            values.push(query[field]!);
          }
        return sqlPage<any>(
          db,
          kind,
          where,
          values,
          query,
          recordBinding(kind, threadId, query),
          "sort_date",
        );
      },
      get: async <K extends RecordKind>(
        kind: K,
        id: string,
        query?: { threadId?: string; atCheckpointId?: string },
      ) => {
        if (!recordTables.includes(kind))
          fail("InvalidConfiguration", "Unknown record kind");
        if (query?.threadId)
          return (records(kind, query.threadId, query.atCheckpointId).find(
            (r: any) => r.id === id,
          ) ?? null) as RecordTypes[K] | null;
        if (query?.atCheckpointId) {
          const row = checkpointRow(query.atCheckpointId);
          return (
            row
              ? (records(kind, row.thread_id, query.atCheckpointId).find(
                  (r) => r.id === id,
                ) ?? null)
              : null
          ) as RecordTypes[K] | null;
        }
        return getJson<RecordTypes[K]>(
          "SELECT r.body FROM " +
            kind +
            " r JOIN threads t ON r.thread_id=t.id WHERE r.id=? AND r.to_revision IS NULL AND t.deleted=0",
          id,
        );
      },
      listRecords: async <K extends RecordKind>(
        kind: K,
        threadId: string,
        query?: { atCheckpointId?: string },
      ) => records(kind, threadId, query?.atCheckpointId) as RecordTypes[K][],
    },
    ownedState: {
      get: async (key) =>
        getJson<PluginStateSnapshot>(
          "SELECT body FROM owned_states WHERE owner_key=?",
          ownerKey(key),
        ),
      compareAndSet: async (state, expected) =>
        transaction(db, () => {
          if (!["agent", "session"].includes(state.ownerType))
            fail(
              "InvalidConfiguration",
              "Execution state must use checkpoints",
            );
          const key = ownerKey(state),
            old = getJson<PluginStateSnapshot>(
              "SELECT body FROM owned_states WHERE owner_key=?",
              key,
            );
          if (
            (old?.revision ?? 0) !== expected ||
            state.revision !== expected + 1
          )
            fail("CommitConflict", "Owned state revision changed");
          db.prepare(
            "INSERT INTO owned_states VALUES(?,?,?) ON CONFLICT(owner_key) DO UPDATE SET revision=excluded.revision,body=excluded.body",
          ).run(key, state.revision, canonicalJson(state));
        }),
    },
    ownership: createOwnership(db),
    commits: {
      stage: async (batch) => {
        validateBatch(batch);
        const fingerprint = await commitFingerprint(batch);
        transaction(db, () => {
          const published = db
            .prepare("SELECT fingerprint FROM commits WHERE id=?")
            .get(batch.commitId);
          if (published) {
            if (published.fingerprint !== fingerprint)
              fail("CommitConflict", "commitId payload mismatch");
            return;
          }
          const old = getJson<CommitBatch>(
            "SELECT body FROM staging WHERE id=?",
            batch.commitId,
          );
          if (old && canonicalJson(old) !== canonicalJson(batch))
            fail("CommitConflict", "commitId payload mismatch");
          if (!old)
            db.prepare("INSERT INTO staging VALUES(?,?,?)").run(
              batch.commitId,
              canonicalJson(batch),
              fingerprint,
            );
        });
      },
      lookupCommit: async (id) =>
        getJson<CommitReceipt>("SELECT body FROM commits WHERE id=?", id),
      publish: async (request) =>
        transaction(db, () => {
          const prior = getJson<CommitReceipt>(
            "SELECT body FROM commits WHERE id=?",
            request.commitId,
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
          assertOwnership(db, request.lease);
          const batch = getJson<CommitBatch>(
            "SELECT body FROM staging WHERE id=?",
            request.commitId,
          );
          if (
            !batch ||
            batch.threadId !== request.threadId ||
            batch.expectedRevision !== request.expectedRevision
          )
            fail("CommitConflict", "Missing staged batch");
          if (batch.lineage) {
            const parent = head(batch.lineage.parentThreadId);
            if (
              !parent ||
              parent.deleted ||
              checkpointRow(batch.lineage.sourceCheckpointId)?.thread_id !==
                parent.id
            )
              fail("ThreadNotFound", "Fork source is no longer available");
          }
          const old = head(batch.threadId),
            cp = batch.checkpoint;
          if (
            (old?.revision ?? 0) !== batch.expectedRevision ||
            old?.deleted ||
            cp.parentCheckpointId !== (old?.currentCheckpointId ?? null)
          )
            fail("CommitConflict", "Head changed");
          if (checkpointRow(cp.id))
            fail("CommitConflict", "Checkpoint ID already exists");
          const merged = new Map<string, RecordEntry>();
          for (const kind of recordTables)
            for (const data of records(kind, batch.threadId))
              merged.set(kind + ":" + data.id, {
                kind,
                id: data.id,
                threadId: batch.threadId,
                data,
              } as RecordEntry);
          for (const entry of batch.records)
            merged.set(entry.kind + ":" + entry.id, entry);
          if (cp.execution && !merged.has("streams:" + cp.execution.streamId))
            fail("CommitConflict", "Missing stream reference");
          if (
            cp.execution?.pendingInterruptId &&
            !merged.has("interrupts:" + cp.execution.pendingInterruptId)
          )
            fail("CommitConflict", "Missing interrupt reference");
          writeCheckpoint(db, cp);
          for (const kind of recordTables)
            writeVersions(
              db,
              kind,
              cp.threadId,
              cp.revision,
              batch.records
                .filter((entry) => entry.kind === kind)
                .map((entry) => ({
                  id: entry.id,
                  body: canonicalJson(entry.data),
                })),
            );
          const stream = cp.execution
            ? (merged.get("streams:" + cp.execution.streamId)
                ?.data as RecordTypes["streams"])
            : null;
          const info = buildThreadInfo(batch, old, stream);
          db.prepare(
            "INSERT INTO threads VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,created_at=excluded.created_at,deleted=excluded.deleted",
          ).run(
            info.id,
            canonicalJson(info),
            info.createdAt,
            Number(info.deleted),
          );
          if (info.deleted) {
            const selections = db
              .prepare("SELECT body FROM sessions WHERE selected_thread_id=?")
              .all(info.id);
            for (const row of selections) {
              const session = JSON.parse(String(row.body)) as SessionRecord;
              const next = {
                ...session,
                selectedThreadId: null,
                revision: session.revision + 1,
                updatedAt: cp.createdAt,
              };
              db.prepare(
                "UPDATE sessions SET selected_thread_id=NULL,revision=?,updated_at=?,body=? WHERE id=?",
              ).run(
                next.revision,
                next.updatedAt,
                canonicalJson(next),
                next.id,
              );
            }
          }
          const receipt = {
            commitId: batch.commitId,
            threadId: batch.threadId,
            revision: cp.revision,
            checkpointId: cp.id,
          };
          db.prepare("INSERT INTO commits VALUES(?,?,?,?)").run(
            batch.commitId,
            canonicalJson(receipt),
            String(
              db
                .prepare("SELECT fingerprint FROM staging WHERE id=?")
                .get(batch.commitId)!.fingerprint,
            ),
            cp.threadId,
          );
          db.prepare("DELETE FROM staging WHERE id=?").run(batch.commitId);
          assertOwnership(db, request.lease);
          return receipt;
        }),
    },
    close: async () => {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
