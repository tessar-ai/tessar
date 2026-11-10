import { createTestDatabase } from "./database-fixture.js";
import { expect, it } from "vitest";
import DatabaseSync from "libsql";
import { mkdtemp } from "node:fs/promises";
import { removeSqliteTestDirectory } from "../../../../tests/helpers/sqlite-cleanup.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HumanMessage, MessageCodec } from "@tessar/core";
import { ThreadService } from "../../../../packages/core/src/state/threads.js";
import { CommitCoordinator } from "../../../../packages/core/src/state/commit.js";
import { createLibsqlBackend } from "../src/backend.js";

it("stores changed message versions once and cleans published staging without losing retry checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tessar-versions-")),
    filename = join(directory, "state.db");
  const backend = await createLibsqlBackend({ database: createTestDatabase(filename)});
  try {
    const service = new ThreadService(backend);
    const thread = await service.create({
      messages: Array.from({ length: 100 }, (_, i) =>
        MessageCodec.encode(new HumanMessage(String(i))),
      ),
    });
    await service.rename(thread.id, "one");
    await service.rename(thread.id, "two");
    const checkpoints = await backend.checkpoints.list(thread.id);
    expect(checkpoints.map((cp) => cp.state.messages.length)).toEqual([
      100, 100, 100,
    ]);
    const db = new DatabaseSync(filename);
    try {
      expect((db.prepare("SELECT count(*) n FROM tessar_messages").get() as { n: number }).n).toBe(100);
      expect((db.prepare("SELECT count(*) n FROM tessar_staging").get() as { n: number }).n).toBe(0);
      expect(
        JSON.parse(
          String(
            (db.prepare("SELECT body FROM tessar_checkpoints LIMIT 1").get() as { body: string }).body,
          ),
        ).state,
      ).not.toHaveProperty("messages");
    } finally {
      db.close();
    }
    const lease = await backend.ownership.acquire({
      threadId: thread.id,
      ownerToken: "test",
      ttlMs: 60000,
    });
    const cp = checkpoints.at(-1)!;
    const batch = {
      commitId: "retry",
      threadId: thread.id,
      expectedRevision: cp.revision,
      checkpoint: {
        ...cp,
        id: "changed",
        parentCheckpointId: cp.id,
        revision: cp.revision + 1,
        state: {
          ...cp.state,
          messages: [
            ...cp.state.messages.slice(1),
            { ...cp.state.messages[0]!, metadata: { changed: true } },
          ],
        },
      },
      records: [],
    };
    const coordinator = new CommitCoordinator(backend);
    const receipt = await coordinator.commit(batch, lease);
    expect(await coordinator.commit(batch, lease)).toEqual(receipt);
    await expect(
      coordinator.commit(
        { ...batch, checkpoint: { ...batch.checkpoint, cause: "Terminal" } },
        lease,
      ),
    ).rejects.toMatchObject({ code: "CommitConflict" });
    expect((await backend.checkpoints.get(cp.id))!.state.messages).toEqual(
      cp.state.messages,
    );
    expect((await backend.checkpoints.get("changed"))!.state.messages).toEqual(
      batch.checkpoint.state.messages,
    );
  } finally {
    await backend.close();
    await removeSqliteTestDirectory(directory);
  }
});
