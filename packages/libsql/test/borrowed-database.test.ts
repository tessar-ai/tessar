import Database from "libsql";
import { expect, it } from "vitest";
import { createLibsqlBackend } from "../src/index.js";
import { LibsqlVectorStore } from "../src/vector.js";

it("isolates state and vectors by namespace without owning the application connection", async () => {
  const database = new Database(":memory:");
  database.exec("CREATE TABLE users(id INTEGER); INSERT INTO users VALUES(1); PRAGMA user_version=42; PRAGMA busy_timeout=123;");
  const embedding = { ref: { providerId: "test", modelId: "test" }, embedDocuments: async (input: readonly unknown[]) => input.map(() => [1, 0]), embedQuery: async () => [1, 0] };
  try {
    const a = await createLibsqlBackend({ database, namespace: "a" });
    const b = await createLibsqlBackend({ database, namespace: "b" });
    await a.records.append({ namespace: "audit", id: "same", data: "a" });
    await b.records.append({ namespace: "audit", id: "same", data: "b" });
    expect((await a.records.get("audit", "same"))!.data).toBe("a");
    expect((await b.records.get("audit", "same"))!.data).toBe("b");
    const av = new LibsqlVectorStore({ database, namespace: "a", embedding, collection: "handbook" });
    const bv = new LibsqlVectorStore({ database, namespace: "b", embedding, collection: "handbook" });
    await av.insert([{ text: "only a", format: "text", metadata: {} }]);
    expect(await bv.list()).toEqual([]);
    expect(await av.searchBM25("only")).toHaveLength(1);
    await av.close();
    await a.close();
    await bv.insert([{ text: "still b", format: "text", metadata: {} }]);
    await bv.close();
    await b.close();
    expect(database.prepare("SELECT id FROM users").get()).toMatchObject({ id: 1 });
    expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 42 });
    expect(database.prepare("PRAGMA busy_timeout").get()).toMatchObject({ timeout: 123 });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name='tessar_records'").get()).toBeUndefined();
  } finally { database.close(); }
});

it.each(["unsafe;drop", "Team"])("does not close a borrowed connection when namespace %s is invalid", async namespace => {
  const database = new Database(":memory:");
  try {
    await expect(createLibsqlBackend({ database, namespace })).rejects.toMatchObject({ code: "InvalidConfiguration" });
    expect(database.prepare("SELECT 1 AS value").get()).toMatchObject({ value: 1 });
  } finally { database.close(); }
});
