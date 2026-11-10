import { openDatabase } from "../src/database.js";
import { createTestDatabase } from "./database-fixture.js";
import DatabaseSync from "libsql";
import { initializeSchema } from "../src/schema.js";
import { AgentHarness } from "@tessar/core/testing";
import { expect, it } from "vitest";
import {
  HumanMessage,
  MessageCodec,
  createMemoryBackend,
  randomIds,
} from "@tessar/core";
import { ThreadService } from "../../../../packages/core/src/state/threads.js";
import { StateQueries } from "../../../../packages/core/src/state/queries.js";
import { createLibsqlBackend } from "../src/backend.js";

for (const name of ["memory", "sqlite"]) {
  it(`${name} pages history without full snapshots and keeps scalar scope types`, async () => {
    const backend =
      name === "memory"
        ? createMemoryBackend()
        : await createLibsqlBackend({ database: createTestDatabase(":memory:")});
    try {
      const service = new ThreadService(backend),
        queries = new StateQueries(backend);
      const scope = { 'x."中': false };
      const info = await service.create({
        scope,
        messages: Array.from({ length: 5 }, (_, i) =>
          MessageCodec.encode(new HumanMessage(String(i))),
        ),
      });
      await service.create({ scope: { 'x."中': 0 } });
      await service.create({ scope: { 'x."中': "false" } });
      expect(
        (await queries.listThreads({ scope })).items.map((t) => t.id),
      ).toEqual([info.id]);
      backend.checkpoints.get = async () => {
        throw Error("full snapshot read");
      };
      const first = await queries.getHistory(info.id, { limit: 2 });
      const second = await queries.getHistory(info.id, {
        limit: 2,
        cursor: first.nextCursor!,
      });
      expect(first.items).toHaveLength(2);
      expect(second.checkpointId).toBe(first.checkpointId);
      expect(second.items.map((m) => m.id)).not.toEqual(
        first.items.map((m) => m.id),
      );
      expect((await queries.listCheckpoints(info.id)).items).toHaveLength(1);
    } finally {
      await backend.close();
    }
  });
  it(`${name} orders equal timestamps by UTF-8 ID and binds history cursors`, async () => {
    const backend =
      name === "memory"
        ? createMemoryBackend()
        : await createLibsqlBackend({ database: createTestDatabase(":memory:")});
    try {
      const ids = ["中", "é", "z", "_", "A", "a", "😀", "!"],
        queries = new StateQueries(backend);
      for (const id of ids)
        await new ThreadService(
          backend,
          { next: (kind) => (kind === "thread" ? id : randomIds.next(kind)) },
          { now: () => "2026-01-01T00:00:00.000Z" },
        ).create();
      const found: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await queries.listThreads({ limit: 2, cursor });
        found.push(...page.items.map((x) => x.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(found).toEqual(["!", "A", "_", "a", "z", "é", "中", "😀"]);
      const service = new ThreadService(backend),
        thread = await service.create({
          messages: ["one", "two", "three"].map((text) =>
            MessageCodec.encode(new HumanMessage(text)),
          ),
        });
      const first = await queries.getHistory(thread.id, { limit: 1 });
      await service.mutate(thread.id, (cp) => ({
        ...cp,
        state: {
          ...cp.state,
          messages: [
            ...cp.state.messages,
            MessageCodec.encode(new HumanMessage("four")),
          ],
        },
      }));
      const second = await queries.getHistory(thread.id, {
        limit: 2,
        cursor: first.nextCursor!,
      });
      expect(second.checkpointId).toBe(first.checkpointId);
      expect(second.items.map((m) => m.content[0])).toEqual([
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]);
      await expect(
        queries.getHistory("A", { cursor: first.nextCursor! }),
      ).rejects.toMatchObject({ code: "InvalidCursor" });
      await expect(
        backend.executions.page("streams", thread.id, {
          atCheckpointId: "missing",
        }),
      ).rejects.toMatchObject({ code: "CheckpointNotFound" });
    } finally {
      await backend.close();
    }
  });
}

for (const name of ["memory", "sqlite"])
  it(`${name} does not read another thread records through a foreign checkpoint`, async () => {
    const backend =
      name === "memory"
        ? createMemoryBackend()
        : await createLibsqlBackend({ database: createTestDatabase(":memory:")});
    const h = await AgentHarness.create({
      backend,
      modelScripts: [{ text: "answer" }],
    });
    try {
      const a = await h.createThread(),
        b = await h.createThread();
      const stream = h.admit({
        kind: "input",
        threadId: b.id,
        input: [MessageCodec.encode(new HumanMessage("hello"))],
        model: h.provider.ref,
      });
      await h.collect(stream);
      const foreign = (await h.checkpoint(b.id)).id;
      expect(
        await backend.executions.listRecords("streams", a.id, {
          atCheckpointId: foreign,
        }),
      ).toEqual([]);
      expect(
        await backend.executions.get("streams", stream.id!, {
          threadId: a.id,
          atCheckpointId: foreign,
        }),
      ).toBeNull();
    } finally {
      await h.dispose();
    }
  });

it("has indexed history-position and parent-record query plans", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    await initializeSchema(openDatabase({ database: db }));
    const history = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT body FROM tessar_messages WHERE thread_id=? AND position>=? AND position<? AND from_revision<=? AND (to_revision IS NULL OR ?<to_revision) ORDER BY position LIMIT ?",
      )
      .all("thread", 0, 10, 1, 1, 10);
    expect(JSON.stringify(history)).toContain("tessar_messages_history");
    const attempts = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT body FROM tessar_model_attempts WHERE thread_id=? AND turn_id=? AND from_revision<=? AND (to_revision IS NULL OR ?<to_revision) ORDER BY sort_date,id LIMIT ?",
      )
      .all("thread", "turn", 1, 1, 10);
    expect(JSON.stringify(attempts)).toContain("model_attempts_turn");
  } finally {
    db.close();
  }
});
