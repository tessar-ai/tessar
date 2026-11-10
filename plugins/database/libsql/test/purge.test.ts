import { createTestDatabase } from "./database-fixture.js";
import { expect, it } from "vitest";
import { createMemoryBackend } from "@tessar/core";
import { ThreadService } from "../../../../packages/core/src/state/threads.js";
import { ForkService } from "../../../../packages/core/src/state/fork.js";
import { createLibsqlBackend } from "../src/backend.js";
for (const name of ["memory", "sqlite"])
  it(`${name} purges only deleted, unowned, unreferenced threads`, async () => {
    const backend =
      name === "memory"
        ? createMemoryBackend()
        : await createLibsqlBackend({ database: createTestDatabase(":memory:") });
    try {
      const threads = new ThreadService(backend);
      const parent = await threads.create({ scope: { user: "a" } });
      await expect(backend.threads.purge(parent.id)).rejects.toMatchObject({
        code: "ThreadNotDeleted",
      });
      const child = await new ForkService(backend).fork(parent.id);
      await threads.delete(parent.id);
      await expect(
        backend.threads.purge(parent.id, { scope: { user: "b" } }),
      ).rejects.toMatchObject({ code: "ThreadNotFound" });
      await expect(backend.threads.purge(parent.id)).rejects.toMatchObject({
        code: "ThreadReferenced",
      });
      await threads.delete(child.id);
      await expect(backend.threads.purge(parent.id)).rejects.toMatchObject({
        code: "ThreadReferenced",
      });
      const lease = await backend.ownership.acquire({
        threadId: child.id,
        ownerToken: "active",
        ttlMs: 30000,
      });
      await expect(backend.threads.purge(child.id)).rejects.toMatchObject({
        code: "ThreadBusy",
      });
      await backend.ownership.release(lease);
      await backend.threads.purge(child.id);
      await backend.threads.purge(parent.id);
      expect(
        await backend.threads.get(parent.id, { includeDeleted: true }),
      ).toBeNull();
      expect(
        await backend.checkpoints.get(parent.currentCheckpointId),
      ).toBeNull();
      expect(
        await backend.executions.listRecords("streams", parent.id),
      ).toEqual([]);
    } finally {
      await backend.close();
    }
  });

for (const name of ["memory", "sqlite"])
  it(`${name} rejects a fork published after its source was purged`, async () => {
    const backend =
      name === "memory"
        ? createMemoryBackend()
        : await createLibsqlBackend({ database: createTestDatabase(":memory:") });
    try {
      const threads = new ThreadService(backend),
        source = await threads.create();
      const stage = backend.commits.stage.bind(backend.commits);
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => (enter = resolve)),
        gate = new Promise<void>((resolve) => (release = resolve));
      backend.commits.stage = async (batch) => {
        if (batch.lineage) {
          enter();
          await gate;
        }
        await stage(batch);
      };
      const fork = new ForkService(backend).fork(source.id).then(
        () => null,
        (e) => e.code,
      );
      await entered;
      await threads.delete(source.id);
      await threads.purge(source.id);
      release();
      expect(await fork).toBe("ThreadNotFound");
      expect(await backend.threads.list()).toEqual([]);
    } finally {
      await backend.close();
    }
  });
