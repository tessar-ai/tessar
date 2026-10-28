import { describe, expect, it } from "vitest";
import type { StorageBackend, CommitBatch } from "../state/storage-ports.js";
import { CommitCoordinator } from "../state/commit.js";
import { ThreadService } from "../state/threads.js";
import type { RecordEntry } from "../state/schema.js";
import { compareOrdinal } from "../state/queries.js";
export function initialBatch(threadId = "t1"): CommitBatch {
  return {
    commitId: "commit-" + threadId,
    threadId,
    expectedRevision: 0,
    checkpoint: {
      id: "cp-" + threadId,
      threadId,
      parentCheckpointId: null,
      revision: 1,
      schemaVersion: 1,
      createdAt: "2026-10-15T00:00:00.000Z",
      state: {
        scope: { userId: "u" },
        metadata: {},
        instructions: null,
        messages: [],
        pluginStates: [],
      },
      execution: null,
      cause: "ThreadCreated",
    },
    records: [],
  };
}
export function storageConformance(
  name: string,
  factory: () => Promise<StorageBackend>,
): void {
  describe(name, () => {
    it("stores independent immutable JSON records without runtime objects", async () => {
      const backend = await factory();
      try {
        const data = { request: { state: "review this" }, answers: ["allow", 0.9] };
        const row = await backend.records.append({ namespace: "decisions", data, scope: { userId: "a" } });
        expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
        expect(Number.isFinite(Date.parse(row.createdAt))).toBe(true);
        data.answers.push("changed");
        expect(await backend.records.get("decisions", row.id)).toEqual(row);
        expect(row.data).toEqual({ request: { state: "review this" }, answers: ["allow", 0.9] });
        expect(Object.isFrozen(row)).toBe(true);
        expect(Object.isFrozen(row.data)).toBe(true);
        expect(await backend.threads.list()).toEqual([]);
        expect(await backend.records.get("missing", row.id)).toBeNull();
        expect(await backend.records.get("decisions", "missing")).toBeNull();
      } finally { await backend.close(); }
    });
    it("rejects duplicate record identities atomically and isolates namespaces", async () => {
      const backend = await factory();
      try {
        const input = { namespace: "decisions", id: "same", data: "first", scope: { userId: "a" } };
        const results = await Promise.allSettled([
          backend.records.append(input), backend.records.append(input),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "RegistrationConflict" } });
        await expect(backend.records.append({ ...input, data: "overwrite", scope: { userId: "b" } })).rejects.toMatchObject({ code: "RegistrationConflict" });
        expect((await backend.records.get("decisions", "same"))?.data).toBe("first");
        await backend.records.append({ ...input, namespace: "other", data: null });
        expect((await backend.records.get("other", "same"))?.data).toBeNull();
      } finally { await backend.close(); }
    });
    it("filters independent records by typed scope and binds page cursors to their query", async () => {
      const backend = await factory();
      try {
        const scope = { 'user.$["id"]': "a", flag: true, tenant: 7 };
        for (const id of ["z", "A", "é", "a"])
          await backend.records.append({ namespace: "decisions", id, scope, data: id });
        await backend.records.append({ namespace: "decisions", id: "hidden", scope: { ...scope, flag: 1 }, data: "hidden" });
        const first = await backend.records.list({ namespace: "decisions", scope, limit: 2 });
        expect(first.items).toHaveLength(2);
        expect(first.nextCursor).not.toBeNull();
        const second = await backend.records.list({ namespace: "decisions", scope, limit: 2, cursor: first.nextCursor! });
        expect(second.items).toHaveLength(2);
        expect(second.nextCursor).toBeNull();
        const all = [...first.items, ...second.items];
        expect(new Set(all.map((row) => row.id)).size).toBe(4);
        expect(all).toEqual([...all].sort((a, b) =>
          compareOrdinal(a.createdAt, b.createdAt) || compareOrdinal(a.id, b.id)));
        expect(await backend.records.get("decisions", "z", { scope })).not.toBeNull();
        expect(await backend.records.get("decisions", "z", { scope: { tenant: "7" } })).toBeNull();
        await expect(backend.records.list({ namespace: "other", scope, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "InvalidCursor" });
        await expect(backend.records.list({ namespace: "decisions", scope: { tenant: 7 }, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "InvalidCursor" });
        await expect(backend.records.list({ namespace: "decisions", limit: 0 })).rejects.toMatchObject({ code: "InvalidConfiguration" });
        await expect(backend.records.list({ namespace: "decisions", limit: 201 })).rejects.toMatchObject({ code: "InvalidConfiguration" });
      } finally { await backend.close(); }
    });
    it("keeps independent records outside checkpoint state and thread purge", async () => {
      const backend = await factory();
      try {
        const thread = await new ThreadService(backend).create({ scope: { userId: "a" } });
        const record = await backend.records.append({ namespace: "audit", data: { threadId: thread.id } });
        const checkpoint = (await backend.checkpoints.get(thread.currentCheckpointId))!;
        expect(checkpoint.state.messages).toEqual([]);
        expect(checkpoint.state.pluginStates).toEqual([]);
        await new ThreadService(backend).delete(thread.id);
        await backend.threads.purge(thread.id);
        expect(await backend.records.get("audit", record.id)).toEqual(record);
      } finally { await backend.close(); }
    });
    it("validates standalone record identities, JSON and scope before writing", async () => {
      const backend = await factory();
      try {
        await expect(backend.records.append({ namespace: "", data: {} })).rejects.toMatchObject({ code: "InvalidConfiguration" });
        await expect(backend.records.append({ namespace: "decisions", id: "", data: {} })).rejects.toMatchObject({ code: "InvalidConfiguration" });
        await expect(backend.records.append({ namespace: "decisions", data: Number.NaN })).rejects.toMatchObject({ code: "InvalidData" });
        await expect(backend.records.append({ namespace: "decisions", data: {}, scope: { invalid: Number.POSITIVE_INFINITY } })).rejects.toMatchObject({ code: "InvalidConfiguration" });
        await expect(backend.records.get("", "id")).rejects.toMatchObject({ code: "InvalidConfiguration" });
        await expect(backend.records.list({ namespace: "" })).rejects.toMatchObject({ code: "InvalidConfiguration" });
        await expect(backend.records.list({ namespace: "decisions", cursor: "%invalid" })).rejects.toMatchObject({ code: "InvalidCursor" });
        expect((await backend.records.list({ namespace: "decisions" })).items).toEqual([]);
      } finally { await backend.close(); }
    });
    it("round-trips tool-result interruptions and suspended/resuming execution records", async () => {
      const backend = await factory();
      try {
        const records: RecordEntry[] = [];
        const batch = { ...initialBatch(), records };
        const lease = await backend.ownership.acquire({
          threadId: batch.threadId,
          ownerToken: "owner",
          ttlMs: 60000,
        });
        for (const status of ["suspended", "resuming"] as const) {
          batch.records.push({
            kind: "tool_executions",
            id: status,
            threadId: batch.threadId,
            data: {
              id: status,
              turnId: "turn",
              streamId: "stream",
              scope: {},
              toolCallId: status,
              parentToolExecutionId: null,
              toolName: "ask",
              arguments: {},
              policyDecision: { decision: "allowed" },
              status,
              startedAt: batch.checkpoint.createdAt,
              endedAt: null,
              durationMs: null,
              resultMessageId: null,
              result: null,
              error: null,
              idempotencyKey: null,
              ...(status === "resuming"
                ? { resume: { interruptId: "question", value: "answer" } }
                : {}),
            },
          });
        }
        batch.records.push({
          kind: "interrupts",
          id: "question",
          threadId: batch.threadId,
          data: {
            kind: "tool-result",
            id: "question",
            threadId: batch.threadId,
            streamId: "stream",
            checkpointId: batch.checkpoint.id,
            definitionId: "ask",
            definitionVersion: 1,
            pluginId: "tools",
            payload: { question: "Choose" },
            responseSchema: { type: "string" },
            actionRef: {
              toolExecutionId: "suspended",
              toolName: "ask",
              argumentsDigest: "{}",
            },
            status: "pending",
            response: null,
            resolvedDecision: null,
            createdAt: batch.checkpoint.createdAt,
            resolvedAt: null,
            revision: 1,
          },
        });
        await new CommitCoordinator(backend).commit(batch, lease);
        for (const record of batch.records) {
          expect(
            await backend.executions.get(record.kind, record.id, {
              threadId: batch.threadId,
            }),
          ).toEqual(record.data);
        }
      } finally {
        await backend.close();
      }
    });
    it("rejects checkpoint identity reuse and leaves the other thread unpublished", async () => {
      const backend = await factory();
      try {
        const original = initialBatch();
        const lease = await backend.ownership.acquire({
          threadId: original.threadId,
          ownerToken: "owner",
          ttlMs: 60000,
        });
        await new CommitCoordinator(backend).commit(original, lease);
        const conflicting = initialBatch("other");
        conflicting.checkpoint.id = original.checkpoint.id;
        const other = await backend.ownership.acquire({
          threadId: conflicting.threadId,
          ownerToken: "other",
          ttlMs: 60000,
        });
        await expect(
          new CommitCoordinator(backend).commit(conflicting, other),
        ).rejects.toMatchObject({ code: "CommitConflict" });
        expect(await backend.threads.get(conflicting.threadId)).toBeNull();
        expect(await backend.checkpoints.get(original.checkpoint.id)).toEqual(
          original.checkpoint,
        );
      } finally {
        await backend.close();
      }
    });
    it("rejects an idempotent commit receipt requested with different membership", async () => {
      const backend = await factory();
      try {
        const batch = initialBatch();
        const lease = await backend.ownership.acquire({
          threadId: batch.threadId,
          ownerToken: "owner",
          ttlMs: 60000,
        });
        await new CommitCoordinator(backend).commit(batch, lease);
        for (const patch of [{ threadId: "other" }, { expectedRevision: 9 }])
          await expect(
            backend.commits.publish({
              commitId: batch.commitId,
              threadId: batch.threadId,
              expectedRevision: 0,
              lease,
              ...patch,
            }),
          ).rejects.toMatchObject({ code: "CommitConflict" });
      } finally {
        await backend.close();
      }
    });
    it("preserves fencing counters through purge and cannot revive an old same-owner lease", async () => {
      const backend = await factory();
      try {
        const batch = initialBatch(),
          ownerToken = "same-owner";
        const old = await backend.ownership.acquire({
          threadId: batch.threadId,
          ownerToken,
          ttlMs: 60000,
        });
        await new CommitCoordinator(backend).commit(batch, old);
        await backend.ownership.release(old);
        await new ThreadService(backend).delete(batch.threadId);
        const beforePurge = await backend.ownership.acquire({
          threadId: batch.threadId,
          ownerToken,
          ttlMs: 60000,
        });
        await backend.ownership.release(beforePurge);
        await backend.threads.purge(batch.threadId);
        const current = await backend.ownership.acquire({
          threadId: batch.threadId,
          ownerToken,
          ttlMs: 60000,
        });
        expect(current.fencingToken).toBeGreaterThan(beforePurge.fencingToken);
        await expect(backend.ownership.renew(old, 60000)).rejects.toMatchObject(
          { code: "OwnershipLost" },
        );
        await backend.ownership.release(old);
        await expect(
          backend.ownership.renew(current, 60000),
        ).resolves.toMatchObject({ fencingToken: current.fencingToken });
      } finally {
        await backend.close();
      }
    });
    it("rejects publication using another thread's valid lease", async () => {
      const backend = await factory();
      try {
        const a = await backend.ownership.acquire({
          threadId: "a",
          ownerToken: "a",
          ttlMs: 60000,
        });
        const b = await backend.ownership.acquire({
          threadId: "b",
          ownerToken: "b",
          ttlMs: 60000,
        });
        const batch = initialBatch("b");
        await backend.commits.stage(batch);
        await expect(
          backend.commits.publish({
            commitId: batch.commitId,
            threadId: "b",
            expectedRevision: 0,
            lease: a,
          }),
        ).rejects.toMatchObject({ code: "OwnershipLost" });
        expect(await backend.threads.get("b")).toBeNull();
        await expect(
          new CommitCoordinator(backend).commit(batch, a),
        ).rejects.toMatchObject({ code: "OwnershipLost" });
        expect(
          (await new CommitCoordinator(backend).commit(batch, b)).threadId,
        ).toBe("b");
      } finally {
        await backend.close();
      }
    });
    it("keeps staging hidden and publishes one immutable revision idempotently", async () => {
      const backend = await factory();
      try {
        const batch = initialBatch();
        const lease = await backend.ownership.acquire({
          threadId: "t1",
          ownerToken: "owner",
          ttlMs: 60000,
        });
        await backend.commits.stage(batch);
        expect(await backend.checkpoints.get(batch.checkpoint.id)).toBeNull();
        const coordinator = new CommitCoordinator(backend);
        const receipt = await coordinator.commit(batch, lease);
        expect(receipt.revision).toBe(1);
        expect(await coordinator.commit(batch, lease)).toEqual(receipt);
        expect(await backend.threads.get("t1")).toMatchObject({
          id: "t1",
          revision: 1,
          currentCheckpointId: "cp-t1",
        });
        await expect(
          coordinator.commit(
            {
              ...batch,
              checkpoint: { ...batch.checkpoint, cause: "Terminal" },
            },
            lease,
          ),
        ).rejects.toMatchObject({ code: "CommitConflict" });
      } finally {
        await backend.close();
      }
    });
    it("rejects concurrent ownership and stale fencing tokens", async () => {
      const backend = await factory();
      try {
        const old = await backend.ownership.acquire({
          threadId: "t1",
          ownerToken: "same-logical-controller/processA",
          ttlMs: 60000,
        });
        await expect(
          backend.ownership.acquire({
            threadId: "t1",
            ownerToken: "same-logical-controller/processB",
            ttlMs: 60000,
          }),
        ).rejects.toMatchObject({ code: "OwnerActive" });
        await backend.ownership.release(old);
        const next = await backend.ownership.acquire({
          threadId: "t1",
          ownerToken: "processB",
          ttlMs: 60000,
        });
        expect(next.fencingToken).toBeGreaterThan(old.fencingToken);
        await backend.commits.stage(initialBatch());
        await expect(
          backend.commits.publish({
            commitId: "commit-t1",
            threadId: "t1",
            expectedRevision: 0,
            lease: old,
          }),
        ).rejects.toMatchObject({ code: "OwnershipLost" });
      } finally {
        await backend.close();
      }
    });
  });
}
