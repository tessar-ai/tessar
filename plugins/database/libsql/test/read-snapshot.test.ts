import NativeDatabase from "libsql";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { HumanMessage, MessageCodec } from "@tessar/core";
import { ThreadService } from "../../../../packages/core/src/state/threads.js";
import { removeSqliteTestDirectory } from "../../../../tests/helpers/sqlite-cleanup.js";
import { createLibsqlBackend } from "../src/backend.js";
import { recordTables } from "../src/schema.js";

it.each(["get", "list", "history"] as const)("keeps a consistent %s snapshot when another connection purges", async operation => {
  const directory = await mkdtemp(join(tmpdir(), "tessar-read-snapshot-"));
  const filename = join(directory, "state.db");
  const reader = new NativeDatabase(filename), writer = new NativeDatabase(filename);
  reader.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  writer.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  let interception: ReturnType<typeof vi.spyOn> | undefined;
  try {
    let activeThreadId: string | undefined;
    let purged = false;
    const prepare = reader.prepare.bind(reader);
    interception = vi.spyOn(reader, "prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      if (!activeThreadId || !sql.includes("FROM tessar_checkpoints")) return statement;
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            const result = Reflect.apply(value, target, args);
            if (!purged && (key === "get" || key === "all")) {
              purged = true;
              // Commit the same row deletions as purge while the reader is between SELECTs.
              writer.exec("BEGIN IMMEDIATE");
              try {
                for (const table of [...recordTables, "messages", "checkpoints", "commits"])
                  writer.prepare(`DELETE FROM tessar_${table} WHERE thread_id=?`).run(activeThreadId!);
                writer.prepare("DELETE FROM tessar_threads WHERE id=?").run(activeThreadId!);
                writer.exec("COMMIT");
              } catch (error) { writer.exec("ROLLBACK"); throw error; }
            }
            return result;
          };
        },
      });
    });
    const backend = await createLibsqlBackend({ database: reader });
    const message = MessageCodec.encode(new HumanMessage("retained snapshot"));
    const info = await new ThreadService(backend).create({ messages: [message] });
    activeThreadId = info.id;
    const expected = [message];
    if (operation === "get") expect((await backend.checkpoints.get(info.currentCheckpointId))?.state.messages).toEqual(expected);
    if (operation === "list") expect((await backend.checkpoints.list(info.id)).map(cp => cp.state.messages)).toEqual([expected]);
    if (operation === "history") expect((await backend.checkpoints.history(info.id, {})).items).toEqual(expected);
    expect(purged).toBe(true);
    expect(await backend.checkpoints.get(info.currentCheckpointId)).toBeNull();
    await backend.close();
  } finally {
    interception?.mockRestore();
    reader.close(); writer.close();
    await removeSqliteTestDirectory(directory);
  }
});
