import { openDatabase, type MongoDBStorageOptions } from "./database.js";
import {
  ensureThread,
  touchThread,
  assertOwnership,
  createOwnership,
} from "./ownership.js";
import {
  interval,
  readVersions,
  writeVersions,
  hydrateCheckpoint,
  writeCheckpoint,
} from "./versions.js";
import type { ClientSession } from "mongodb";
import {
  buildThreadInfo,
  canonicalJson,
  commitFingerprint,
  encodeCursor,
  fail,
  historyCursor,
  immutable,
  limitOf,
  matchesScope,
  recordBinding,
  validateBatch,
  validateSession,
  type Checkpoint,
  type CommitBatch,
  type CommitReceipt,
  type MessageData,
  type PluginStateSnapshot,
  type RecordEntry,
  type RecordKind,
  type RecordTypes,
  type SessionRecord,
  type StorageBackend,
  type ThreadInfo,
} from "@tessar/core";
import { decode, mongoPage, scopeFilter, scopeTokens } from "./queries.js";
import { createRecordStore } from "./records.js";

const kinds = [
  "streams",
  "turns",
  "model_attempts",
  "tool_executions",
  "interrupts",
] as const;
const key = (...parts: (string | number)[]) => canonicalJson(parts);
const validKind = (kind: RecordKind) => {
  if (!kinds.includes(kind))
    fail("InvalidConfiguration", "Unknown record kind");
};
export type { MongoDBStorageOptions } from "./database.js";

export async function createMongoDBBackend(
  options: MongoDBStorageOptions,
): Promise<StorageBackend> {
  const db = await openDatabase(options);
  const {
    threads,
    checkpoints,
    versions,
    sessions,
    owned,
    leases,
    commits,
    staging,
    pieces,
    transaction,
  } = db;
  const head = async (id: string, session?: ClientSession) =>
    decode<ThreadInfo>(await threads.findOne({ _id: id }, { session }));
  const cpRow = (id: string, session?: ClientSession) =>
    checkpoints.findOne({ _id: id }, { session });
  async function recordCheckpoint(
    threadId: string,
    atCheckpointId: string | undefined,
    session: ClientSession,
  ) {
    const row = await cpRow(
      atCheckpointId ??
        (await head(threadId, session))?.currentCheckpointId ??
        "",
      session,
    );
    return row?.threadId === threadId ? row : null;
  }
  const ownerKey = (
    value: Pick<
      PluginStateSnapshot,
      "ownerType" | "ownerId" | "pluginId" | "namespace"
    >,
  ) => key(value.ownerType, value.ownerId, value.pluginId, value.namespace);
  return {
    records: createRecordStore(db.records),
    id: "mongodb",
    capabilities: {
      durable: true,
      atomicPublish: true,
      coordination: "multi-process",
    },
    sessions: {
      get: async (id, query = {}) =>
        decode<SessionRecord>(
          await sessions.findOne({ _id: id, ...scopeFilter(query.scope) }),
        ),
      page: (query) =>
        mongoPage<SessionRecord>(
          sessions,
          { agentId: query.agentId, ...scopeFilter(query.scope) },
          query,
          canonicalJson({ agentId: query.agentId, scope: query.scope ?? {} }),
        ),
      compareAndSet: async (value, expected) => {
        value = immutable(value);
        if (value.selectedThreadId)
          await ensureThread(leases, value.selectedThreadId);
        await transaction(async (session) => {
          if (value.selectedThreadId)
            await touchThread(leases, value.selectedThreadId, session);
          const old = decode<SessionRecord>(
            await sessions.findOne({ _id: value.id }, { session }),
          );
          validateSession(
            value,
            old,
            expected,
            value.selectedThreadId
              ? await head(value.selectedThreadId, session)
              : null,
          );
          await sessions.replaceOne(
            { _id: value.id },
            {
              _id: value.id,
              id: value.id,
              agentId: value.agentId,
              selectedThreadId: value.selectedThreadId,
              scopeTokens: scopeTokens(value.scope),
              sortDate: value.createdAt,
              body: canonicalJson(value),
            },
            { upsert: true, session },
          );
        });
      },
    },
    ownedState: {
      get: async (value) =>
        decode<PluginStateSnapshot>(
          await owned.findOne({ _id: ownerKey(value) }),
        ),
      compareAndSet: (value, expected) => {
        value = immutable(value);
        return transaction(async (session) => {
          if (!["agent", "session"].includes(value.ownerType))
            fail(
              "InvalidConfiguration",
              "Execution state must use checkpoints",
            );
          const id = ownerKey(value),
            old = decode<PluginStateSnapshot>(
              await owned.findOne({ _id: id }, { session }),
            );
          if (
            (old?.revision ?? 0) !== expected ||
            value.revision !== expected + 1
          )
            fail("CommitConflict", "Owned state revision changed");
          await owned.replaceOne(
            { _id: id },
            { _id: id, body: canonicalJson(value) },
            { session, upsert: true },
          );
        });
      },
    },
    ownership: createOwnership(leases),
    threads: {
      get: async (id, options) => {
        const value = await head(id);
        return value && (!value.deleted || options?.includeDeleted)
          ? value
          : null;
      },
      list: async (query = {}) =>
        (
          await threads
            .find({ deleted: false, ...scopeFilter(query.scope) })
            .toArray()
        ).map((row) => decode<ThreadInfo>(row)!),
      page: (query) =>
        mongoPage<ThreadInfo>(
          threads,
          { deleted: false, ...scopeFilter(query.scope) },
          query,
          canonicalJson(query.scope ?? {}),
        ),
      purge: async (id, query = {}) => {
        await ensureThread(leases, id);
        await transaction(async (session) => {
          const free = await leases.updateOne(
            { _id: id, $expr: { $lte: ["$expiresAt", "$$NOW"] } },
            { $inc: { serial: 1 } },
            { session },
          );
          const info = await head(id, session);
          if (!info || !matchesScope(info.scope, query.scope))
            fail("ThreadNotFound", "Thread does not match query");
          if (!info.deleted)
            fail("ThreadNotDeleted", "Soft-delete the thread before purging");
          if (!free.matchedCount || info.activeStreamId)
            fail("ThreadBusy", "Thread has active execution or ownership");
          if (await threads.findOne({ parentThreadId: id }, { session }))
            fail("ThreadReferenced", "Retained fork references this thread");
          // A retained fork can also identify its source checkpoint explicitly.
          for await (const cp of checkpoints.find(
            { threadId: id },
            { session },
          ))
            if (
              await threads.findOne({ sourceCheckpointId: cp._id }, { session })
            )
              fail("ThreadReferenced", "Retained fork references this thread");
          for (const collection of [
            versions,
            checkpoints,
            commits,
            staging,
            pieces,
          ])
            await collection.deleteMany({ threadId: id }, { session });
          await threads.deleteOne({ _id: id }, { session });
        });
      },
    },
    checkpoints: {
      get: (id) =>
        transaction(async (session) => {
          const row = await cpRow(id, session);
          return row ? hydrateCheckpoint(versions, row, session) : null;
        }),
      list: (threadId) =>
        transaction(async (session) => {
          const rows = await checkpoints
              .find({ threadId }, { session })
              .sort({ revision: 1 })
              .toArray(),
            result: Checkpoint[] = [];
          for (const row of rows)
            result.push(await hydrateCheckpoint(versions, row, session));
          return result;
        }),
      page: (threadId, options) =>
        mongoPage(
          checkpoints,
          { threadId },
          options,
          "checkpoints:" + threadId,
          undefined,
          (row) => ({
            id: row._id,
            threadId,
            revision: row.revision,
            createdAt: row.sortDate,
            cause: row.cause,
            forkable: row.forkable,
            unsafeReason: row.unsafeReason,
          }),
        ),
      history: (threadId, options, query = {}) =>
        transaction(async (session) => {
          const info = await head(threadId, session);
          if (!info || info.deleted || !matchesScope(info.scope, query.scope))
            fail("ThreadNotFound", "Thread does not match query");
          const { binding, cursor } = historyCursor(threadId, options, query),
            limit = limitOf(options.limit);
          const cp = await recordCheckpoint(
            threadId,
            cursor?.checkpointId ??
              options.atCheckpointId ??
              info.currentCheckpointId,
            session,
          );
          if (!cp) fail("CheckpointNotFound", "No checkpoint for history");
          const end = cursor?.end ?? cp.messageCount;
          if (end > cp.messageCount)
            fail("InvalidCursor", "Invalid history position");
          const begin = Math.max(0, end - limit);
          const items = (
            await versions
              .find(
                {
                  ...interval(threadId, "messages", cp.revision),
                  position: { $gte: begin, $lt: end },
                },
                { session },
              )
              .sort({ position: 1 })
              .limit(limit)
              .toArray()
          ).map((row) => decode<MessageData>(row)!);
          return {
            items,
            checkpointId: cp._id,
            revision: cp.revision,
            nextCursor: begin
              ? encodeCursor({
                  v: 1,
                  binding,
                  checkpointId: cp._id,
                  end: begin,
                })
              : null,
          };
        }),
    },
    executions: {
      page: (kind, threadId, query) =>
        transaction(async (session) => {
          validKind(kind);
          const cp = await recordCheckpoint(
            threadId,
            query.atCheckpointId,
            session,
          );
          if (!cp) fail("CheckpointNotFound", "No checkpoint for records");
          const filter = interval(threadId, kind, cp.revision);
          for (const field of ["streamId", "turnId", "status"] as const)
            if (query[field] !== undefined) filter[field] = query[field];
          return mongoPage<any>(
            versions,
            filter,
            query,
            recordBinding(kind, threadId, query),
            session,
          );
        }),
      listRecords: <K extends RecordKind>(
        kind: K,
        threadId: string,
        query?: { atCheckpointId?: string },
      ) =>
        transaction(async (session) => {
          validKind(kind);
          const cp = await recordCheckpoint(
            threadId,
            query?.atCheckpointId,
            session,
          );
          return cp
            ? readVersions<RecordTypes[K]>(
                versions,
                kind,
                threadId,
                cp.revision,
                session,
              )
            : [];
        }),
      get: <K extends RecordKind>(
        kind: K,
        id: string,
        query?: { threadId?: string; atCheckpointId?: string },
      ) =>
        transaction(async (session) => {
          validKind(kind);
          if (query?.threadId || query?.atCheckpointId) {
            const cp = query.threadId
              ? await recordCheckpoint(
                  query.threadId,
                  query.atCheckpointId,
                  session,
                )
              : await cpRow(query.atCheckpointId!, session);
            return cp
              ? decode<RecordTypes[K]>(
                  await versions.findOne(
                    { ...interval(cp.threadId, kind, cp.revision), id },
                    { session },
                  ),
                )
              : null;
          }
          for await (const row of versions.find(
            { kind, id, toRevision: null },
            { session },
          )) {
            const info = await head(row.threadId, session);
            if (info && !info.deleted) return decode<RecordTypes[K]>(row);
          }
          return null;
        }),
    },
    commits: {
      lookupCommit: async (id) =>
        decode<CommitReceipt>(await commits.findOne({ _id: id })),
      stage: async (batch) => {
        batch = immutable(batch);
        validateBatch(batch);
        for (const record of batch.records) validKind(record.kind);
        const fingerprint = await commitFingerprint(batch);
        await ensureThread(leases, batch.threadId);
        await transaction(async (session) => {
          await touchThread(leases, batch.threadId, session);
          const old =
            (await commits.findOne({ _id: batch.commitId }, { session })) ??
            (await staging.findOne({ _id: batch.commitId }, { session }));
          if (old) {
            if (old.fingerprint !== fingerprint)
              fail("CommitConflict", "commitId payload mismatch");
            return;
          }
          const { messages, ...state } = batch.checkpoint.state;
          const { records, ...rest } = batch;
          await staging.insertOne(
            {
              _id: batch.commitId,
              threadId: batch.threadId,
              fingerprint,
              body: canonicalJson({
                ...rest,
                checkpoint: { ...batch.checkpoint, state },
              }),
            },
            { session },
          );
          // Each message/record gets its own document; histories can exceed 16 MiB.
          for (const [position, message] of messages.entries())
            await pieces.insertOne(
              {
                _id: key(batch.commitId, "messages", position),
                commitId: batch.commitId,
                threadId: batch.threadId,
                kind: "messages",
                position,
                body: canonicalJson(message),
              },
              { session },
            );
          for (const [position, record] of records.entries())
            await pieces.insertOne(
              {
                _id: key(batch.commitId, "records", position),
                commitId: batch.commitId,
                threadId: batch.threadId,
                kind: "records",
                position,
                body: canonicalJson(record),
              },
              { session },
            );
        });
      },
      publish: (request) => {
        request = immutable(request);
        return transaction(async (session) => {
          const prior = decode<CommitReceipt>(
            await commits.findOne({ _id: request.commitId }, { session }),
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
          await assertOwnership(leases, request.lease, session);
          const staged = await staging.findOne(
            { _id: request.commitId },
            { session },
          );
          const batch = decode<CommitBatch>(staged);
          if (
            !batch ||
            batch.threadId !== request.threadId ||
            batch.expectedRevision !== request.expectedRevision
          )
            fail("CommitConflict", "Missing staged batch");
          const messages = (
            await pieces
              .find({ commitId: batch.commitId, kind: "messages" }, { session })
              .sort({ position: 1 })
              .toArray()
          ).map((row) => decode<MessageData>(row)!);
          const records = (
            await pieces
              .find({ commitId: batch.commitId, kind: "records" }, { session })
              .sort({ position: 1 })
              .toArray()
          ).map((row) => decode<RecordEntry>(row)!);
          const cp: Checkpoint = {
            ...batch.checkpoint,
            state: { ...batch.checkpoint.state, messages },
          };
          if (batch.lineage) {
            await touchThread(leases, batch.lineage.parentThreadId, session);
            const parent = await head(batch.lineage.parentThreadId, session);
            const source = await cpRow(
              batch.lineage.sourceCheckpointId,
              session,
            );
            if (!parent || parent.deleted || source?.threadId !== parent.id)
              fail("ThreadNotFound", "Fork source is no longer available");
          }
          const old = await head(batch.threadId, session);
          if (
            (old?.revision ?? 0) !== batch.expectedRevision ||
            old?.deleted ||
            cp.parentCheckpointId !== (old?.currentCheckpointId ?? null)
          )
            fail("CommitConflict", "Head changed");
          if (await cpRow(cp.id, session))
            fail("CommitConflict", "Checkpoint ID already exists");
          const merged = new Map<string, RecordEntry>();
          for (const entry of records)
            merged.set(key(entry.kind, entry.id), entry);
          async function record<K extends RecordKind>(
            kind: K,
            id: string,
          ): Promise<RecordTypes[K] | null> {
            const entry = merged.get(key(kind, id));
            return entry
              ? (entry.data as RecordTypes[K])
              : decode<RecordTypes[K]>(
                  await versions.findOne(
                    { threadId: batch!.threadId, kind, id, toRevision: null },
                    { session },
                  ),
                );
          }
          const stream = cp.execution
            ? await record("streams", cp.execution.streamId)
            : null;
          if (cp.execution && !stream)
            fail("CommitConflict", "Missing stream reference");
          if (
            cp.execution?.pendingInterruptId &&
            !(await record("interrupts", cp.execution.pendingInterruptId))
          )
            fail("CommitConflict", "Missing interrupt reference");
          await writeCheckpoint(checkpoints, versions, cp, session);
          for (const kind of kinds)
            await writeVersions(
              versions,
              kind,
              cp.threadId,
              cp.revision,
              [...merged.values()]
                .filter((entry) => entry.kind === kind)
                .map((entry) => ({
                  id: entry.id,
                  body: canonicalJson(entry.data),
                })),
              session,
            );
          const info = buildThreadInfo(
            { ...batch, checkpoint: cp, records },
            old,
            stream,
          );
          await threads.replaceOne(
            { _id: info.id },
            {
              _id: info.id,
              id: info.id,
              deleted: info.deleted,
              scopeTokens: scopeTokens(info.scope),
              sortDate: info.createdAt,
              parentThreadId: info.parentThreadId,
              sourceCheckpointId: info.sourceCheckpointId,
              body: canonicalJson(info),
            },
            { session, upsert: true },
          );
          if (info.deleted)
            for await (const row of sessions.find(
              { selectedThreadId: info.id },
              { session },
            )) {
              const value = decode<SessionRecord>(row)!;
              const next = {
                ...value,
                selectedThreadId: null,
                revision: value.revision + 1,
                updatedAt: cp.createdAt,
              };
              await sessions.updateOne(
                { _id: row._id },
                { $set: { selectedThreadId: null, body: canonicalJson(next) } },
                { session },
              );
            }
          const receipt: CommitReceipt = {
            commitId: batch.commitId,
            threadId: cp.threadId,
            revision: cp.revision,
            checkpointId: cp.id,
          };
          await commits.insertOne(
            {
              _id: batch.commitId,
              threadId: cp.threadId,
              fingerprint: staged!.fingerprint,
              body: canonicalJson(receipt),
            },
            { session },
          );
          await staging.deleteOne({ _id: batch.commitId }, { session });
          await pieces.deleteMany({ commitId: batch.commitId }, { session });
          await assertOwnership(leases, request.lease, session);
          return receipt;
        });
      },
    },
    close: db.close,
  };
}
