import {
  MongoClient,
  MongoServerError,
  type MongoClientOptions,
  type ClientSession,
  type Filter,
} from "mongodb";
import {
  buildThreadInfo,
  canonicalJson,
  checkpointSafety,
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
  type Lease,
  type MessageData,
  type PluginStateSnapshot,
  type RecordEntry,
  type RecordKind,
  type RecordTypes,
  type SessionRecord,
  type StorageBackend,
  type ThreadInfo,
} from "@tessar/core";
import {
  decode,
  mongoPage,
  scopeFilter,
  scopeTokens,
  type Row,
} from "./queries.js";

export interface MongoDBStorageOptions {
  uri: string;
  databaseName: string;
  clientOptions?: MongoClientOptions;
}
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
const duration = (ttlMs: number) => {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0)
    fail("InvalidConfiguration", "Invalid lease duration");
};
const toLease = (row: Row): Lease => ({
  threadId: row._id,
  ownerToken: row.ownerToken,
  fencingToken: row.fencingToken,
  expiresAt: row.expiresAt.toISOString(),
});
const liveLease = (lease: Lease): Filter<Row> => ({
  _id: lease.threadId,
  ownerToken: lease.ownerToken,
  fencingToken: lease.fencingToken,
  $expr: { $gt: ["$expiresAt", "$$NOW"] },
});

export async function createMongoDBBackend(
  options: MongoDBStorageOptions,
): Promise<StorageBackend> {
  if (!options.databaseName)
    fail("InvalidConfiguration", "MongoDB databaseName is required");
  const client = new MongoClient(options.uri, options.clientOptions);
  const db = client.db(options.databaseName);
  const threads = db.collection<Row>("tessar_threads"),
    checkpoints = db.collection<Row>("tessar_checkpoints"),
    versions = db.collection<Row>("tessar_versions"),
    sessions = db.collection<Row>("tessar_sessions"),
    owned = db.collection<Row>("tessar_owned_states"),
    leases = db.collection<Row>("tessar_leases"),
    commits = db.collection<Row>("tessar_commits"),
    staging = db.collection<Row>("tessar_staging"),
    pieces = db.collection<Row>("tessar_staging_pieces");
  try {
    await client.connect();
    const hello = await db.command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid")
      fail(
        "InvalidConfiguration",
        "MongoDB storage requires a replica set or sharded deployment supporting transactions",
      );
    // Create every collection before entering transactions (including otherwise unindexed ones).
    for (const collection of [
      threads,
      checkpoints,
      versions,
      sessions,
      owned,
      leases,
      commits,
      staging,
      pieces,
    ]) {
      try {
        await db.createCollection(collection.collectionName);
      } catch (error) {
        if (!(error instanceof MongoServerError && error.code === 48))
          throw error;
      }
    }
    await threads.createIndex({ deleted: 1, sortDate: 1, id: 1 });
    await threads.createIndex({
      scopeTokens: 1,
      deleted: 1,
      sortDate: 1,
      id: 1,
    });
    await threads.createIndex({ parentThreadId: 1 });
    await threads.createIndex({ sourceCheckpointId: 1 });
    await checkpoints.createIndex(
      { threadId: 1, revision: 1 },
      { unique: true },
    );
    await checkpoints.createIndex({ threadId: 1, sortDate: 1, id: 1 });
    await versions.createIndex(
      { threadId: 1, kind: 1, id: 1, fromRevision: 1 },
      { unique: true },
    );
    await versions.createIndex({
      threadId: 1,
      kind: 1,
      toRevision: 1,
      position: 1,
    });
    await versions.createIndex({ threadId: 1, kind: 1, sortDate: 1, id: 1 });
    await versions.createIndex({ kind: 1, id: 1, toRevision: 1 });
    await sessions.createIndex({
      agentId: 1,
      scopeTokens: 1,
      sortDate: 1,
      id: 1,
    });
    await sessions.createIndex({ selectedThreadId: 1 });
    await commits.createIndex({ threadId: 1 });
    await staging.createIndex({ threadId: 1 });
    await pieces.createIndex({ commitId: 1, kind: 1, position: 1 });
    await pieces.createIndex({ threadId: 1 });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }

  async function transaction<T>(
    action: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = client.startSession();
    try {
      return (await session.withTransaction(() => action(session), {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      }))!;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000)
        fail("CommitConflict", "Storage identity or revision already exists");
      throw error;
    } finally {
      await session.endSession();
    }
  }
  // These documents survive release/purge. Every relevant writer touches them;
  // snapshot reads alone cannot serialize source validation or session selection.
  async function ensureThread(id: string): Promise<void> {
    try {
      await leases.updateOne(
        { _id: id },
        {
          $setOnInsert: {
            fencingToken: 0,
            ownerToken: "",
            expiresAt: new Date(0),
            serial: 0,
            body: "{}",
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 11000))
        throw error;
    }
  }
  async function touchThread(
    id: string,
    session: ClientSession,
  ): Promise<void> {
    await leases.updateOne({ _id: id }, { $inc: { serial: 1 } }, { session });
  }
  const head = async (id: string, session?: ClientSession) =>
    decode<ThreadInfo>(await threads.findOne({ _id: id }, { session }));
  const cpRow = (id: string, session?: ClientSession) =>
    checkpoints.findOne({ _id: id }, { session });
  const interval = (
    threadId: string,
    kind: string,
    revision: number,
  ): Filter<Row> => ({
    threadId,
    kind,
    fromRevision: { $lte: revision },
    $or: [{ toRevision: null }, { toRevision: { $gt: revision } }],
  });
  async function readVersions<T>(
    kind: string,
    threadId: string,
    revision: number,
    session: ClientSession,
  ): Promise<T[]> {
    return (
      await versions
        .find(interval(threadId, kind, revision), { session })
        .sort(kind === "messages" ? { position: 1 } : { sortDate: 1, id: 1 })
        .toArray()
    ).map((row) => decode<T>(row)!);
  }
  async function hydrate(
    row: Row,
    session: ClientSession,
  ): Promise<Checkpoint> {
    const cp = decode<Checkpoint>(row)!;
    return immutable({
      ...cp,
      state: {
        ...cp.state,
        messages: await readVersions<MessageData>(
          "messages",
          cp.threadId,
          cp.revision,
          session,
        ),
      },
    });
  }
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
  async function writeVersions(
    kind: string,
    threadId: string,
    revision: number,
    entries: readonly { id: string; body: string; position?: number }[],
    session: ClientSession,
    replace = false,
  ) {
    const current = new Map(
      (
        await versions
          .find({ threadId, kind, toRevision: null }, { session })
          .toArray()
      ).map((row) => [row.id as string, row]),
    );
    for (const entry of entries) {
      const old = current.get(entry.id);
      current.delete(entry.id);
      if (old?.body === entry.body && old.position === (entry.position ?? null))
        continue;
      if (old)
        await versions.updateOne(
          { _id: old._id },
          { $set: { toRevision: revision } },
          { session },
        );
      const value = JSON.parse(entry.body);
      await versions.insertOne(
        {
          _id: key(threadId, kind, entry.id, revision),
          threadId,
          kind,
          id: entry.id,
          fromRevision: revision,
          toRevision: null,
          position: entry.position ?? null,
          streamId: value.streamId ?? null,
          turnId: value.turnId ?? null,
          status: value.status ?? null,
          sortDate: value.createdAt ?? value.startedAt ?? "",
          body: entry.body,
        },
        { session },
      );
    }
    if (replace)
      for (const row of current.values())
        await versions.updateOne(
          { _id: row._id },
          { $set: { toRevision: revision } },
          { session },
        );
  }
  const ownerKey = (
    value: Pick<
      PluginStateSnapshot,
      "ownerType" | "ownerId" | "pluginId" | "namespace"
    >,
  ) => key(value.ownerType, value.ownerId, value.pluginId, value.namespace);
  let closePromise: Promise<void> | undefined;
  return {
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
        if (value.selectedThreadId) await ensureThread(value.selectedThreadId);
        await transaction(async (session) => {
          if (value.selectedThreadId)
            await touchThread(value.selectedThreadId, session);
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
    ownership: {
      acquire: async (request) => {
        request = immutable(request);
        duration(request.ttlMs);
        await ensureThread(request.threadId);
        const row = await leases.findOneAndUpdate(
          { _id: request.threadId, $expr: { $lte: ["$expiresAt", "$$NOW"] } },
          [
            {
              $set: {
                ownerToken: { $literal: request.ownerToken },
                fencingToken: { $add: ["$fencingToken", 1] },
                serial: { $add: ["$serial", 1] },
                expiresAt: { $add: ["$$NOW", request.ttlMs] },
              },
            },
          ],
          { returnDocument: "after" },
        );
        if (!row) fail("OwnerActive", "Thread has active owner");
        return toLease(row);
      },
      renew: async (lease, ttlMs) => {
        lease = immutable(lease);
        duration(ttlMs);
        const row = await leases.findOneAndUpdate(
          liveLease(lease),
          [
            {
              $set: {
                serial: { $add: ["$serial", 1] },
                expiresAt: { $add: ["$$NOW", ttlMs] },
              },
            },
          ],
          { returnDocument: "after" },
        );
        if (!row) fail("OwnershipLost", "Lease no longer owns thread");
        return toLease(row);
      },
      release: async (lease) => {
        lease = immutable(lease);
        await leases.updateOne(
          {
            _id: lease.threadId,
            ownerToken: lease.ownerToken,
            fencingToken: lease.fencingToken,
          },
          { $set: { expiresAt: new Date(0) }, $inc: { serial: 1 } },
        );
      },
    },
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
        await ensureThread(id);
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
          return row ? hydrate(row, session) : null;
        }),
      list: (threadId) =>
        transaction(async (session) => {
          const rows = await checkpoints
              .find({ threadId }, { session })
              .sort({ revision: 1 })
              .toArray(),
            result: Checkpoint[] = [];
          for (const row of rows) result.push(await hydrate(row, session));
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
            ? readVersions<RecordTypes[K]>(kind, threadId, cp.revision, session)
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
        await ensureThread(batch.threadId);
        await transaction(async (session) => {
          await touchThread(batch.threadId, session);
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
          if (prior.threadId !== request.threadId || prior.revision !== request.expectedRevision + 1)
            fail("CommitConflict", "Commit request mismatch");
          return prior;
        }
          if (request.lease.threadId !== request.threadId)
            fail("OwnershipLost", "Lease belongs to another thread");
          const ownedLease = await leases.updateOne(
            liveLease(request.lease),
            { $inc: { serial: 1 } },
            { session },
          );
          if (!ownedLease.matchedCount)
            fail("OwnershipLost", "Lease no longer owns thread");
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
            await touchThread(batch.lineage.parentThreadId, session);
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
          await writeVersions(
            "messages",
            cp.threadId,
            cp.revision,
            messages.map((message, position) => ({
              id: message.id,
              position,
              body: canonicalJson(message),
            })),
            session,
            true,
          );
          for (const kind of kinds)
            await writeVersions(
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
          const { messages: _messages, ...state } = cp.state;
          await checkpoints.insertOne(
            {
              _id: cp.id,
              id: cp.id,
              threadId: cp.threadId,
              revision: cp.revision,
              sortDate: cp.createdAt,
              cause: cp.cause,
              messageCount: messages.length,
              ...checkpointSafety(cp),
              body: canonicalJson({ ...cp, state }),
            },
            { session },
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
        // A lease can expire while a large transaction is writing its versions.
        const stillOwned = await leases.updateOne(liveLease(request.lease), { $inc: { serial: 1 } }, { session });
        if (!stillOwned.matchedCount) fail("OwnershipLost", "Lease expired during publication");
          return receipt;
        });
      },
    },
    close: () => (closePromise ??= client.close()),
  };
}
