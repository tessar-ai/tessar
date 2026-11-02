import { removeSqliteTestDirectory as rm } from "../../../tests/helpers/sqlite-cleanup.js";
import {
  createThread,
  deleteThread,
} from "../../core/src/state/thread-operations.js";
import { expect, it, vi } from "vitest";
import DatabaseSync from "libsql";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  storageConformance,
  initialBatch,
} from "@tessar/core/testing/storage-conformance";
import { AgentHarness } from "@tessar/core/testing";
import { CommitCoordinator } from "../../core/src/state/commit.js";
import { createLibsqlBackend } from "../src/backend.js";
storageConformance("sqlite", async () =>
  createLibsqlBackend({ filename: ":memory:" }),
);
it("rolls back publication when a lease expires during SQLite writes", async () => {
  const backend = await createLibsqlBackend({ filename: ":memory:" }),
    batch = initialBatch();
  await backend.commits.stage(batch);
  const lease = await backend.ownership.acquire({
    threadId: batch.threadId,
    ownerToken: "slow",
    ttlMs: 500,
  });
  const prepare = DatabaseSync.prototype.prepare;
  let reachedHeadWrite = false;
  const slow = vi
    .spyOn(DatabaseSync.prototype, "prepare")
    .mockImplementation(function (this: DatabaseSync.Database, sql) {
      if (sql.startsWith("INSERT INTO tessar_threads")) {
        reachedHeadWrite = true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
      }
      return prepare.call(this, sql);
    });
  try {
    await expect(
      backend.commits.publish({
        commitId: batch.commitId,
        threadId: batch.threadId,
        expectedRevision: 0,
        lease,
      }),
    ).rejects.toMatchObject({ code: "OwnershipLost" });
    expect(reachedHeadWrite).toBe(true);
    expect(await backend.threads.get(batch.threadId)).toBeNull();
    expect(await backend.checkpoints.get(batch.checkpoint.id)).toBeNull();
    expect(await backend.commits.lookupCommit(batch.commitId)).toBeNull();
  } finally {
    slow.mockRestore();
    await backend.close();
  }
});
it("reopens committed state and fences independently connected owners", async () => {
  const path = await mkdtemp(join(tmpdir(), "tessar-"));
  const filename = join(path, "state.db"),
    a = await createLibsqlBackend({ filename }),
    b = await createLibsqlBackend({ filename });
  try {
    const lease = await a.ownership.acquire({
      threadId: "t1",
      ownerToken: "a",
      ttlMs: 60000,
    });
    await expect(
      b.ownership.acquire({ threadId: "t1", ownerToken: "b", ttlMs: 60000 }),
    ).rejects.toMatchObject({ code: "OwnerActive" });
    await new CommitCoordinator(a).commit(initialBatch(), lease);
    expect(await b.threads.get("t1")).toMatchObject({ revision: 1 });
    await a.ownership.release(lease);
    const next = await b.ownership.acquire({
      threadId: "t1",
      ownerToken: "b",
      ttlMs: 60000,
    });
    expect(next.fencingToken).toBeGreaterThan(lease.fencingToken);
  } finally {
    await a.close();
    await b.close();
  }
  const reopened = await createLibsqlBackend({ filename });
  try {
    expect(await reopened.checkpoints.get("cp-t1")).toMatchObject({
      revision: 1,
    });
  } finally {
    await reopened.close();
    await rm(path, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

it("persists Session CAS, validates scope/Agent identity, and clears all deleted selections", async () => {
  const backend = await createLibsqlBackend({ filename: ":memory:" });
  const h = await AgentHarness.create({ backend });
  try {
    const a = await h.controller.createSession({ scope: { user: "a" } }),
      b = await h.controller.createSession({ scope: { user: "a" } });
    const thread = await a.thread.create();
    await b.thread.switch(thread.id);
    const stale = (await h.controller.getSession(a.id))!;
    const other = await createThread(h.controller, { scope: { user: "a" } });
    await a.thread.switch(other.id);
    expect(
      await stale.thread.switch(thread.id).then(
        () => null,
        (e) => e.code,
      ),
    ).toBe("CommitConflict");
    expect(
      await h.controller.getSession(a.id, { scope: { user: "b" } }),
    ).toBeNull();
    const row = (await backend.sessions.get(a.id))!;
    await backend.sessions.compareAndSet(
      {
        ...row,
        id: "other-agent",
        agentId: "other",
        revision: 1,
        selectedThreadId: null,
      },
      0,
    );
    expect(
      await h.controller.getSession("other-agent").then(
        () => null,
        (e) => e.code,
      ),
    ).toBe("SessionAgentMismatch");
    await a.thread.switch(thread.id);
    await deleteThread(h.controller, thread.id);
    expect((await backend.sessions.get(a.id))?.selectedThreadId).toBeNull();
    expect((await backend.sessions.get(b.id))?.selectedThreadId).toBeNull();
  } finally {
    await h.dispose();
  }
});
