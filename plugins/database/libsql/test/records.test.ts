import { createTestDatabase } from "./database-fixture.js";
import { removeSqliteTestDirectory as rm } from "../../../../tests/helpers/sqlite-cleanup.js";
import { expect, it } from "vitest";
import DatabaseSync from "libsql";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, Controller, type PluginContext } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { createLibsqlBackend, LibsqlStoragePlugin } from "../src/index.js";

it("uses the SQLite backend through plugin record access and persists across reopen", async () => {
  const path = await mkdtemp(join(tmpdir(), "tessar-records-"));
  const filename = join(path, "state.db");
  let storage!: PluginContext["storage"];
  const controller = new Controller({
    id: "sqlite-records-controller",
    agent: new Agent({ id: "sqlite-records-agent", model: new ScriptedProvider([]) }),
    plugins: [
      { id: "consumer-first", setup(tessar) { storage = tessar.storage; } },
      new LibsqlStoragePlugin({ database: createTestDatabase(filename) }),
    ],
  });
  try {
    await controller.initialize();
    await storage.records.append({ namespace: "decisions", id: "saved", scope: { userId: "a" }, data: { answer: "allow" } });
  } finally { await controller.dispose(); }
  const reopened = await createLibsqlBackend({ database: createTestDatabase(filename) });
  try {
    expect((await reopened.records.get("decisions", "saved", { scope: { userId: "a" } }))?.data).toEqual({ answer: "allow" });
    expect(await reopened.threads.list()).toEqual([]);
  } finally {
    await reopened.close();
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

it("adds the independent records schema to an existing v1 SQLite database", async () => {
  const path = await mkdtemp(join(tmpdir(), "tessar-records-schema-"));
  const filename = join(path, "state.db");
  const first = await createLibsqlBackend({ database: createTestDatabase(filename) });
  await first.close();
  const legacy = new DatabaseSync(filename);
  legacy.exec("DROP TABLE IF EXISTS tessar_records");
  legacy.close();
  const backend = await createLibsqlBackend({ database: createTestDatabase(filename) });
  try {
    const value = await backend.records.append({ namespace: "audit", data: "new" });
    expect(await backend.records.get("audit", value.id)).toEqual(value);
  } finally {
    await backend.close();
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
