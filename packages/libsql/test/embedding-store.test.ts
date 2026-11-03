import { createTestDatabase } from "./database-fixture.js";
import { expect, it, vi } from "vitest";
import { LibsqlVectorStore } from "@tessar/libsql/vector";
import Database from "libsql";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { removeSqliteTestDirectory } from "../../../tests/helpers/sqlite-cleanup.js";

const content = { text: "manual", format: "text" as const, metadata: {} };
function model() {
  return { ref: { providerId: "fixture", modelId: "test" },
    embedDocuments: vi.fn(async () => [[1, 0]]), embedQuery: vi.fn(async () => [1, 0]) };
}

async function filename() {
  const directory = await mkdtemp(join(tmpdir(), "tessar-embedding-store-"));
  onTestFinished(() => removeSqliteTestDirectory(directory));
  return join(directory, "vectors.db");
}

it("configures embedding once and learns dimensions from the first insert", async () => {
  const embedding = model();
  const store = new LibsqlVectorStore({ database: createTestDatabase(":memory:"), embedding });
  try {
    expect(await store.info()).toEqual({ collection: "default", model: embedding.ref, dimensions: null });
    expect(await store.insert([])).toEqual([]);
    expect(await store.search("manual")).toEqual([]);
    expect(await store.searchBM25("manual")).toEqual([]);
    expect(embedding.embedDocuments).not.toHaveBeenCalled();
    expect(embedding.embedQuery).not.toHaveBeenCalled();
    const ids = await store.insert([content]);
    expect(embedding.embedDocuments).toHaveBeenCalledExactlyOnceWith([content]);
    expect(await store.info()).toMatchObject({ dimensions: 2 });
    expect((await store.search("question"))[0]).toMatchObject({ id: ids[0], content, score: 1 });
    expect(embedding.embedQuery).toHaveBeenCalledExactlyOnceWith("question");
  } finally { await store.close(); }
});

it("persists identity/dimensions, rejects another model, and keeps dimensions after deleting all rows", async () => {
  const file = await filename(), embedding = model();
  const store = new LibsqlVectorStore({ database: createTestDatabase(file), embedding });
  const ids = await store.insert([content]);
  await store.delete({ ids });
  embedding.embedQuery.mockClear();
  expect(await store.search("empty")).toEqual([]);
  expect(embedding.embedQuery).not.toHaveBeenCalled();
  await store.close();
  const reopened = new LibsqlVectorStore({ database: createTestDatabase(file), embedding: model() });
  try { expect(await reopened.info()).toEqual({ collection: "default", model: embedding.ref, dimensions: 2 }); }
  finally { await reopened.close(); }
  for (const ref of [
    { providerId: "other", modelId: "test" }, { providerId: "fixture", modelId: "other" },
    { providerId: "fixture", modelId: "test", connectionId: "other" },
  ]) expect(() => new LibsqlVectorStore({ database: createTestDatabase(file), embedding: { ...model(), ref } }))
    .toThrow(/different embedding model/);
});

it("does not overwrite vectors or dimensions when a later embedding changes dimensions", async () => {
  const embedding = model(), store = new LibsqlVectorStore({ database: createTestDatabase(":memory:"), embedding });
  try {
    const ids = await store.insert([content]);
    embedding.embedDocuments.mockResolvedValue([[1, 0, 0]]);
    await expect(store.insert([content])).rejects.toMatchObject({ code: "InvalidData" });
    embedding.embedQuery.mockResolvedValue([1, 0, 0]);
    await expect(store.search("question")).rejects.toMatchObject({ code: "InvalidData" });
    expect((await store.list()).map(r => r.id)).toEqual(ids);
    expect(await store.info()).toMatchObject({ dimensions: 2 });
  } finally { await store.close(); }
});

it.each([[], [[NaN, 0]], [[Infinity, 0]], [[]], [[0, 0]], [[1, 0], [1, 0]], [new Array(2)]].map(output => ({ output })))
  ("rejects invalid embedding output without initializing dimensions: %j", async ({ output }) => {
    const embedding = model(), store = new LibsqlVectorStore({ database: createTestDatabase(":memory:"), embedding });
    try {
      embedding.embedDocuments.mockResolvedValue(output);
      await expect(store.insert([content])).rejects.toMatchObject({ code: "InvalidData" });
      expect(await store.list()).toEqual([]);
      expect(await store.info()).toMatchObject({ dimensions: null });
    } finally { await store.close(); }
  });

it("validates content and removed signatures before calling the provider", async () => {
  const embedding = model(), store = new LibsqlVectorStore({ database: createTestDatabase(":memory:"), embedding });
  try {
    for (const input of [{ contents: [content], vectors: [[1, 0]] }, "manual", [{ text: "missing format" }]])
      await expect(store.insert(input as never)).rejects.toMatchObject({ code: "InvalidData" });
    expect(embedding.embedDocuments).not.toHaveBeenCalled();
    for (const input of [[1, 0], { query: "manual" }, ""])
      await expect(store.search(input as never)).rejects.toMatchObject({ code: "InvalidData" });
    expect(embedding.embedQuery).not.toHaveBeenCalled();
  } finally { await store.close(); }
});

it("rejects a mutable adapter changing its model identity after construction", async () => {
  const embedding = model(), store = new LibsqlVectorStore({ database: createTestDatabase(":memory:"), embedding });
  try {
    embedding.ref.modelId = "different";
    await expect(store.insert([content])).rejects.toMatchObject({ code: "InvalidConfiguration" });
    expect(embedding.embedDocuments).not.toHaveBeenCalled();
    expect(await store.info()).toMatchObject({ model: { modelId: "test" }, dimensions: null });
  } finally { await store.close(); }
});

it("preserves provider exceptions and permits retry by the caller", async () => {
  const embedding = model(), store = new LibsqlVectorStore({ database: createTestDatabase(":memory:"), embedding });
  const error = new Error("provider failed");
  try {
    embedding.embedDocuments.mockRejectedValueOnce(error);
    await expect(store.insert([content])).rejects.toBe(error);
    expect(await store.info()).toMatchObject({ dimensions: null });
    await store.insert([content]);
    embedding.embedQuery.mockRejectedValueOnce(error);
    await expect(store.search("manual")).rejects.toBe(error);
    expect(await store.list()).toHaveLength(1);
  } finally { await store.close(); }
});

it("accepts omitted or explicitly undefined optional connection identity consistently", async () => {
  const embedding = { ...model(), ref: { providerId: "fixture", modelId: "test", connectionId: undefined } };
  const store = new LibsqlVectorStore({ database: createTestDatabase(":memory:"), embedding });
  try {
    await store.insert([content]);
    expect(await store.info()).toMatchObject({ model: { providerId: "fixture", modelId: "test" }, dimensions: 2 });
    expect(await store.search("manual")).toHaveLength(1);
  } finally { await store.close(); }
});

it("does not adopt old collections whose embedding model is unknown", async () => {
  const file = await filename(), db = new Database(file);
  try {
    db.exec("CREATE TABLE tessar_vector_collections(name TEXT PRIMARY KEY,dimensions INTEGER NOT NULL); INSERT INTO tessar_vector_collections VALUES('default',2)");
    expect(() => new LibsqlVectorStore({ database: createTestDatabase(file), embedding: model() })).toThrow(/no embedding model identity/);
    expect(db.prepare("SELECT * FROM tessar_vector_collections").all()).toEqual([{ name: "default", dimensions: 2 }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='tessar_vector_models'").all()).toEqual([]);
  } finally { db.close(); }
});

it("resolves competing first-insert dimensions using committed collection metadata", async () => {
  const file = await filename(), first = model(), second = model();
  const ready = Promise.withResolvers<number[][]>();
  first.embedDocuments.mockReturnValueOnce(ready.promise);
  second.embedDocuments.mockResolvedValue([[1, 0, 0]]);
  const a = new LibsqlVectorStore({ database: createTestDatabase(file), embedding: first });
  const b = new LibsqlVectorStore({ database: createTestDatabase(file), embedding: second });
  try {
    const pending = a.insert([content]);
    await b.insert([content]);
    ready.resolve([[1, 0]]);
    await expect(pending).rejects.toMatchObject({ code: "InvalidData" });
    expect(await a.info()).toMatchObject({ dimensions: 3 });
    expect(await a.list()).toHaveLength(1);
  } finally { ready.resolve([[1, 0]]); await a.close(); await b.close(); }
});

it("does not write after closing while an embedding request is pending", async () => {
  const embedding = model(), store = new LibsqlVectorStore({ database: createTestDatabase(":memory:"), embedding });
  const ready = Promise.withResolvers<number[][]>();
  embedding.embedDocuments.mockReturnValueOnce(ready.promise);
  const pending = store.insert([content]);
  await store.close();
  ready.resolve([[1, 0]]);
  await expect(pending).rejects.toMatchObject({ code: "InvalidState" });
  await expect(store.info()).rejects.toMatchObject({ code: "InvalidState" });
});
