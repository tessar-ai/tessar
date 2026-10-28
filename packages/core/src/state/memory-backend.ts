import { fail, requireId } from "../errors.js";
import { prepareStoredRecord, type StoredRecord } from "./records.js";
import { immutable, systemClock, type Clock } from "../json.js";
import {
  canonicalJson,
  validateBatch,
  commitFingerprint,
  buildThreadInfo,
} from "./commit.js";
import type {
  Checkpoint,
  ThreadInfo,
  RecordEntry,
  RecordKind,
  RecordTypes,
  PluginStateSnapshot,
  SessionRecord,
} from "./schema.js";
import {
  pageRows,
  recordBinding,
  historyCursor,
  limitOf,
  encodeCursor,
  checkpointSafety,
} from "./queries.js";
import { validateSession } from "./sessions.js";
import { matchesScope, normalizeScope } from "./scope.js";
import type {
  CommitBatch,
  CommitReceipt,
  Lease,
  StorageBackend,
} from "./storage-ports.js";
export function createMemoryBackend(
  options: { clock?: Clock } = {},
): StorageBackend {
  const clock = options.clock ?? systemClock;
  const heads = new Map<string, ThreadInfo>(),
    snapshots = new Map<string, Checkpoint>(),
    records = new Map<string, readonly RecordEntry[]>();
  const staged = new Map<string, CommitBatch>(),
    receipts = new Map<string, CommitReceipt>(),
    leases = new Map<string, Lease>(),
    fences = new Map<string, number>();
  let closed = false;
  const fingerprints = new Map<string, string>();
  const stagedFingerprints = new Map<string, string>();
  const sessions = new Map<string, SessionRecord>();
  const ownedStates = new Map<string, PluginStateSnapshot>();
  const independentRecords = new Map<string, StoredRecord>();
  const ownerKey = (
    key: Pick<
      PluginStateSnapshot,
      "ownerType" | "ownerId" | "pluginId" | "namespace"
    >,
  ) => canonicalJson([key.ownerType, key.ownerId, key.pluginId, key.namespace]);
  const guard = () => {
    if (closed) fail("Disposed", "Backend closed");
  };
  const assertLease = (lease: Lease) => {
    guard();
    const active = leases.get(lease.threadId);
    if (
      !active ||
      active.ownerToken !== lease.ownerToken ||
      active.fencingToken !== lease.fencingToken ||
      Date.parse(active.expiresAt) <= Date.parse(clock.now())
    )
      fail("OwnershipLost", "Lease no longer owns thread");
  };
  const currentRecords = (
    threadId: string,
    checkpointId?: string,
  ): readonly RecordEntry[] => {
    const id = checkpointId ?? heads.get(threadId)?.currentCheckpointId ?? "";
    return snapshots.get(id)?.threadId === threadId
      ? (records.get(id) ?? [])
      : [];
  };
  const allRecords = (checkpointId?: string) =>
    checkpointId
      ? (records.get(checkpointId) ?? [])
      : [...heads.values()]
          .filter((h) => !h.deleted)
          .flatMap((h) => currentRecords(h.id));
  const backend: StorageBackend = {
    records: {
      append: async (options) => {
        guard();
        const value = prepareStoredRecord(options, clock.now());
        const key = canonicalJson([value.namespace, value.id]);
        if (independentRecords.has(key))
          fail("RegistrationConflict", "Record ID already exists in namespace");
        independentRecords.set(key, value);
        return value;
      },
      get: async (namespace, id, query = {}) => {
        guard();
        requireId(namespace, "record namespace");
        requireId(id, "record id");
        const scope = normalizeScope(query.scope);
        const value = independentRecords.get(canonicalJson([namespace, id]));
        return value && matchesScope(value.scope, scope) ? value : null;
      },
      list: async (query) => {
        guard();
        requireId(query.namespace, "record namespace");
        const scope = normalizeScope(query.scope);
        return pageRows(
          [...independentRecords.values()].filter((value) =>
            value.namespace === query.namespace && matchesScope(value.scope, scope)),
          query,
          canonicalJson({ records: query.namespace, scope }),
        );
      },
    },
    sessions: {
      get: async (id, query = {}) => {
        guard();
        const row = sessions.get(id);
        return row && matchesScope(row.scope, query.scope) ? row : null;
      },
      page: async (query) => {
        guard();
        return pageRows(
          [...sessions.values()].filter(
            (row) =>
              row.agentId === query.agentId &&
              matchesScope(row.scope, query.scope),
          ),
          query,
          canonicalJson({ agentId: query.agentId, scope: query.scope ?? {} }),
        );
      },
      compareAndSet: async (value, expected) => {
        guard();
        validateSession(
          value,
          sessions.get(value.id) ?? null,
          expected,
          value.selectedThreadId
            ? (heads.get(value.selectedThreadId) ?? null)
            : null,
        );
        sessions.set(value.id, immutable(value));
      },
    },
    ownedState: {
      get: async (key) => {
        guard();
        return ownedStates.get(ownerKey(key)) ?? null;
      },
      compareAndSet: async (state, expectedRevision) => {
        guard();
        if (!["agent", "session"].includes(state.ownerType))
          fail(
            "InvalidConfiguration",
            "Thread/stream/turn state must use checkpoint commits",
          );
        const key = ownerKey(state);
        if (
          (ownedStates.get(key)?.revision ?? 0) !== expectedRevision ||
          state.revision !== expectedRevision + 1
        )
          fail("CommitConflict", "Owned state revision changed");
        ownedStates.set(key, immutable(state));
      },
    },
    id: "memory",
    capabilities: {
      durable: false,
      atomicPublish: true,
      coordination: "single-process",
    },
    threads: {
      purge: async (id, query = {}) => {
        guard();
        const head = heads.get(id);
        if (!head || !matchesScope(head.scope, query.scope))
          fail("ThreadNotFound", "Thread does not match query");
        if (!head.deleted)
          fail("ThreadNotDeleted", "Soft-delete the thread before purging");
        const lease = leases.get(id);
        if (
          head.activeStreamId ||
          (lease && Date.parse(lease.expiresAt) > Date.parse(clock.now()))
        )
          fail("ThreadBusy", "Thread has active execution or ownership");
        if (
          [...heads.values()].some(
            (h) =>
              h.parentThreadId === id ||
              (h.sourceCheckpointId &&
                snapshots.get(h.sourceCheckpointId)?.threadId === id),
          )
        )
          fail("ThreadReferenced", "Retained fork references this thread");
        for (const [key, cp] of snapshots)
          if (cp.threadId === id) {
            snapshots.delete(key);
            records.delete(key);
          }
        for (const [key, batch] of staged)
          if (batch.threadId === id) {
            staged.delete(key);
            stagedFingerprints.delete(key);
          }
        for (const [key, receipt] of receipts)
          if (receipt.threadId === id) {
            receipts.delete(key);
            fingerprints.delete(key);
          }
        heads.delete(id);
        leases.delete(id);
      },
      page: async (query) => {
        guard();
        return pageRows(
          [...heads.values()].filter(
            (h) => !h.deleted && matchesScope(h.scope, query.scope),
          ),
          query,
          canonicalJson(query.scope ?? {}),
        );
      },
      get: async (id, options) => {
        guard();
        const head = heads.get(id);
        return head && (!head.deleted || options?.includeDeleted) ? head : null;
      },
      list: async (query) => {
        guard();
        return [...heads.values()].filter(
          (h) => !h.deleted && matchesScope(h.scope, query?.scope),
        );
      },
    },
    checkpoints: {
      page: async (threadId, options) => {
        guard();
        return pageRows(
          [...snapshots.values()]
            .filter((cp) => cp.threadId === threadId)
            .map((cp) => ({
              id: cp.id,
              threadId,
              revision: cp.revision,
              createdAt: cp.createdAt,
              cause: cp.cause,
              ...checkpointSafety(cp),
            })),
          options,
          "checkpoints:" + threadId,
        );
      },
      history: async (id, options, query = {}) => {
        guard();
        const head = heads.get(id);
        if (!head || head.deleted || !matchesScope(head.scope, query.scope))
          fail("ThreadNotFound", "Thread does not match query");
        const { binding, cursor } = historyCursor(id, options, query),
          limit = limitOf(options.limit);
        const cp = snapshots.get(
          cursor?.checkpointId ??
            options.atCheckpointId ??
            head.currentCheckpointId,
        );
        if (!cp || cp.threadId !== id)
          fail("CheckpointNotFound", "No checkpoint for history");
        const end = cursor?.end ?? cp.state.messages.length;
        if (end > cp.state.messages.length)
          fail("InvalidCursor", "Invalid history position");
        const begin = Math.max(0, end - limit);
        return {
          items: cp.state.messages.slice(begin, end),
          checkpointId: cp.id,
          revision: cp.revision,
          nextCursor: begin
            ? encodeCursor({ v: 1, binding, checkpointId: cp.id, end: begin })
            : null,
        };
      },
      get: async (id) => {
        guard();
        return snapshots.get(id) ?? null;
      },
      list: async (id) => {
        guard();
        return [...snapshots.values()].filter((cp) => cp.threadId === id);
      },
    },
    executions: {
      page: async (kind, threadId, query) => {
        guard();
        const cp = snapshots.get(
          query.atCheckpointId ??
            heads.get(threadId)?.currentCheckpointId ??
            "",
        );
        if (!cp || cp.threadId !== threadId)
          fail("CheckpointNotFound", "No checkpoint for records");
        const rows = currentRecords(threadId, query.atCheckpointId)
          .filter((r) => r.kind === kind)
          .map((r) => r.data as any)
          .filter(
            (r) =>
              (query.streamId === undefined || r.streamId === query.streamId) &&
              (query.turnId === undefined || r.turnId === query.turnId) &&
              (query.status === undefined || r.status === query.status),
          );
        return pageRows(rows, query, recordBinding(kind, threadId, query));
      },
      get: async <K extends RecordKind>(
        kind: K,
        id: string,
        query?: { threadId?: string; atCheckpointId?: string },
      ) => {
        guard();
        const entries = query?.threadId
          ? currentRecords(query.threadId, query.atCheckpointId)
          : allRecords(query?.atCheckpointId);
        return (entries.find((e) => e.kind === kind && e.id === id)?.data ??
          null) as RecordTypes[K] | null;
      },
      listRecords: async <K extends RecordKind>(
        kind: K,
        threadId: string,
        query?: { atCheckpointId?: string },
      ) => {
        guard();
        return currentRecords(threadId, query?.atCheckpointId)
          .filter((e) => e.kind === kind)
          .map((e) => e.data) as RecordTypes[K][];
      },
    },
    commits: {
      stage: async (batch) => {
        guard();
        validateBatch(batch);
        const hash = await commitFingerprint(batch);
        guard();
        if (fingerprints.has(batch.commitId)) {
          if (fingerprints.get(batch.commitId) !== hash)
            fail("CommitConflict", "commitId reused with different payload");
          return;
        }
        const prior = staged.get(batch.commitId);
        if (prior && canonicalJson(prior) !== canonicalJson(batch))
          fail("CommitConflict", "commitId reused with different payload");
        if (!prior) {
          staged.set(batch.commitId, immutable(batch));
          stagedFingerprints.set(batch.commitId, hash);
        }
      },
      lookupCommit: async (id) => {
        guard();
        return receipts.get(id) ?? null;
      },
      publish: async (request) => {
        guard();
        const prior = receipts.get(request.commitId);
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
        assertLease(request.lease);
        const batch = staged.get(request.commitId);
        if (
          !batch ||
          batch.threadId !== request.threadId ||
          batch.expectedRevision !== request.expectedRevision
        )
          fail("CommitConflict", "Missing staged batch");
        if (batch.lineage) {
          const parent = heads.get(batch.lineage.parentThreadId);
          if (
            !parent ||
            parent.deleted ||
            snapshots.get(batch.lineage.sourceCheckpointId)?.threadId !==
              parent.id
          )
            fail("ThreadNotFound", "Fork source is no longer available");
        }
        const head = heads.get(batch.threadId);
        if ((head?.revision ?? 0) !== batch.expectedRevision || head?.deleted)
          fail("CommitConflict", "Head revision changed");
        if (
          batch.checkpoint.parentCheckpointId !==
          (head?.currentCheckpointId ?? null)
        )
          fail("CommitConflict", "Checkpoint parent mismatch");
        if (snapshots.has(batch.checkpoint.id))
          fail("CommitConflict", "Checkpoint ID already published");
        const merged = new Map(
          currentRecords(batch.threadId).map((r) => [r.kind + ":" + r.id, r]),
        );
        for (const record of batch.records)
          merged.set(record.kind + ":" + record.id, record);
        const execution = batch.checkpoint.execution;
        if (execution && !merged.has("streams:" + execution.streamId))
          fail("CommitConflict", "Execution references missing stream");
        if (
          execution?.pendingInterruptId &&
          !merged.has("interrupts:" + execution.pendingInterruptId)
        )
          fail("CommitConflict", "Execution references missing interrupt");
        const cp = immutable(batch.checkpoint);
        const stream = execution
          ? (merged.get("streams:" + execution.streamId)
              ?.data as RecordTypes["streams"])
          : null;
        const info = immutable(buildThreadInfo(batch, head, stream));
        const receipt = immutable({
          commitId: batch.commitId,
          threadId: batch.threadId,
          revision: cp.revision,
          checkpointId: cp.id,
        });
        snapshots.set(cp.id, cp);
        records.set(cp.id, immutable([...merged.values()]));
        heads.set(batch.threadId, info);
        if (info.deleted)
          for (const [id, session] of sessions)
            if (session.selectedThreadId === info.id)
              sessions.set(
                id,
                immutable({
                  ...session,
                  selectedThreadId: null,
                  revision: session.revision + 1,
                  updatedAt: cp.createdAt,
                }),
              );
        receipts.set(batch.commitId, receipt);
        fingerprints.set(
          batch.commitId,
          stagedFingerprints.get(batch.commitId)!,
        );
        stagedFingerprints.delete(batch.commitId);
        staged.delete(batch.commitId);
        return receipt;
      },
    },
    ownership: {
      acquire: async (request) => {
        guard();
        const now = Date.parse(clock.now()),
          active = leases.get(request.threadId);
        if (!Number.isFinite(request.ttlMs) || request.ttlMs <= 0)
          fail("InvalidConfiguration", "Invalid lease duration");
        if (active && Date.parse(active.expiresAt) > now)
          fail("OwnerActive", "Thread has active owner");
        const fencingToken = (fences.get(request.threadId) ?? 0) + 1;
        fences.set(request.threadId, fencingToken);
        const lease = immutable({
          ...request,
          fencingToken,
          expiresAt: new Date(now + request.ttlMs).toISOString(),
        });
        leases.set(request.threadId, lease);
        return lease;
      },
      renew: async (lease, ttlMs) => {
        assertLease(lease);
        if (!Number.isFinite(ttlMs) || ttlMs <= 0)
          fail("InvalidConfiguration", "Invalid lease duration");
        const renewed = immutable({
          ...lease,
          expiresAt: new Date(Date.parse(clock.now()) + ttlMs).toISOString(),
        });
        leases.set(lease.threadId, renewed);
        return renewed;
      },
      release: async (lease) => {
        guard();
        const active = leases.get(lease.threadId);
        if (
          active?.fencingToken === lease.fencingToken &&
          active.ownerToken === lease.ownerToken
        )
          leases.delete(lease.threadId);
      },
    },
    close: async () => {
      closed = true;
      sessions.clear();
      independentRecords.clear();
      fingerprints.clear();
      stagedFingerprints.clear();
      heads.clear();
      snapshots.clear();
      records.clear();
      staged.clear();
      receipts.clear();
      leases.clear();
    },
  };
  return backend;
}
