import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PostgresqlVectorStore } from "../src/vector.js";

const content = { text: "hello", format: "text" as const, metadata: { project: "handbook" } };

function fixture() {
  const ref = { providerId: "fixture", modelId: "test" };
  const embedding = { ref, embedDocuments: vi.fn(async (input: readonly unknown[]) => input.map(() => [1, 0])), embedQuery: vi.fn(async () => [1, 0]) };
  const model = { ...ref };
  let dimensions: number | null = null;
  let rows = false;
  const query = vi.fn(async (sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    if (sql.includes("FROM pg_extension")) return { rows: [{ schema: "extensions" }], rowCount: 1 };
    if (sql.includes("SELECT model,dimensions")) return { rows: [{ model, dimensions }], rowCount: 1 };
    if (sql.includes("SELECT dimensions")) return { rows: [{ dimensions }], rowCount: 1 };
    if (sql.includes("SELECT to_regclass")) return { rows: [{ relation: null }], rowCount: 1 };
    if (sql.startsWith("UPDATE") && sql.includes("SET dimensions")) dimensions = values![0] as number;
    if (sql.includes("jsonb_to_recordset")) { rows = true; return { rows: [], rowCount: JSON.parse(values![0] as string).length }; }
    if (sql.includes("SELECT 1 AS present")) return { rows: rows ? [{ present: 1 }] : [], rowCount: rows ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }) as unknown as PoolClient);
  const end = vi.fn();
  const pool = { connect, end } as unknown as Pool;
  return { pool, query, release, connect, end, embedding, setDimensions(value: number) { dimensions = value; } };
}

it("initializes lazily and reports null dimensions without calling the model", async () => {
  const f = fixture();
  const store = new PostgresqlVectorStore({ pool: f.pool, embedding: f.embedding });
  expect(f.connect).not.toHaveBeenCalled();
  expect(await store.info()).toEqual({ collection: "default", model: f.embedding.ref, dimensions: null });
  expect(f.embedding.embedDocuments).not.toHaveBeenCalled();
  expect(f.embedding.embedQuery).not.toHaveBeenCalled();
  expect(f.query.mock.calls.some(([sql]) => sql.includes("CREATE EXTENSION"))).toBe(false);
  expect(f.release).toHaveBeenCalledTimes(f.connect.mock.calls.length);
});

it("embeds outside transactions and sends one ordered atomic bulk insert", async () => {
  const f = fixture();
  let active = false;
  const query = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, values) => {
    if (sql.startsWith("BEGIN")) active = true;
    if (sql === "COMMIT" || sql === "ROLLBACK") active = false;
    return query(sql, values);
  });
  f.embedding.embedDocuments.mockImplementation(async input => { expect(active).toBe(false); return input.map(() => [1, 0]); });
  const store = new PostgresqlVectorStore({ pool: f.pool, embedding: f.embedding, collection: "handbook" });
  const original = structuredClone(content);
  const pending = store.insert([original, { ...content, text: "second" }]);
  original.text = "changed";
  const ids = await pending;
  expect(ids).toHaveLength(2);
  expect(ids.every(id => /^[a-f0-9-]{36}$/.test(id))).toBe(true);
  expect(f.embedding.embedDocuments).toHaveBeenCalledWith([content, { ...content, text: "second" }]);
  const inserts = f.query.mock.calls.filter(([sql]) => sql.includes("jsonb_to_recordset"));
  expect(inserts).toHaveLength(1);
  expect(JSON.parse(inserts[0]![1]![0] as string).map((row: { id: string }) => row.id)).toEqual(ids);
  expect((await store.info()).dimensions).toBe(2);
});

it("propagates provider failure without publishing records or leaking clients", async () => {
  const f = fixture(), error = Error("provider failed");
  f.embedding.embedDocuments.mockRejectedValueOnce(error);
  const store = new PostgresqlVectorStore({ pool: f.pool, embedding: f.embedding });
  await expect(store.insert([content])).rejects.toBe(error);
  expect(f.query.mock.calls.some(([sql]) => sql.includes("jsonb_to_recordset"))).toBe(false);
  expect(f.release).toHaveBeenCalledTimes(f.connect.mock.calls.length);
});

it("rejects changed model identity and incompatible dimensions", async () => {
  const f = fixture();
  const store = new PostgresqlVectorStore({ pool: f.pool, embedding: f.embedding });
  await store.info();
  f.embedding.ref.modelId = "changed";
  await expect(store.insert([content])).rejects.toMatchObject({ code: "InvalidConfiguration" });
  f.embedding.ref.modelId = "test";
  f.setDimensions(3);
  await expect(store.insert([content])).rejects.toMatchObject({ code: "InvalidData" });
});

it("closes only its facade and rejects further work", async () => {
  const f = fixture();
  const store = new PostgresqlVectorStore({ pool: f.pool, embedding: f.embedding });
  await store.close(); await store.close();
  await expect(store.info()).rejects.toMatchObject({ code: "InvalidState" });
  await expect(store.insert([content])).rejects.toMatchObject({ code: "InvalidState" });
  expect(f.end).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
});

it("validates inputs without contacting the pool", async () => {
  const f = fixture(), store = new PostgresqlVectorStore({ pool: f.pool, embedding: f.embedding });
  expect(() => new PostgresqlVectorStore({ pool: f.pool, embedding: f.embedding, schema: null as never }))
    .toThrow(expect.objectContaining({ code: "InvalidConfiguration" }));
  await expect(store.insert([{ ...content, text: 1 } as never])).rejects.toMatchObject({ code: "InvalidData" });
  await expect(store.list({ filter: {} })).rejects.toMatchObject({ code: "InvalidData" });
  await expect(store.delete({ ids: [] })).rejects.toMatchObject({ code: "InvalidData" });
  await expect(store.search("q", { topK: 0 })).rejects.toMatchObject({ code: "InvalidData" });
  expect(f.connect).not.toHaveBeenCalled();
});

it("keeps native search and storage usable when pg_search is absent", async () => {
  const f = fixture();
  const query = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, values) => {
    if (sql.includes("FROM pg_extension") && (sql.includes("pg_search") || values?.includes("pg_search")))
      return { rows: [], rowCount: 0 };
    return query(sql, values);
  });
  const store = new PostgresqlVectorStore({ pool: f.pool, embedding: f.embedding });
  await expect(store.searchBM25("manual")).rejects.toMatchObject({ code: "InvalidConfiguration" });
  expect(await store.searchNative("manual")).toEqual([]);
  expect(await store.list()).toEqual([]);
  expect(await store.info()).toMatchObject({ dimensions: null });
  expect(f.embedding.embedDocuments).not.toHaveBeenCalled();
  expect(f.embedding.embedQuery).not.toHaveBeenCalled();
  expect(f.query.mock.calls.some(([sql]) => /CREATE EXTENSION|ALTER SYSTEM|SET shared_preload/i.test(sql))).toBe(false);
  expect(f.release).toHaveBeenCalledTimes(f.connect.mock.calls.length);
});

it("validates both lexical APIs before pool access", async () => {
  const f = fixture(), store = new PostgresqlVectorStore({ pool: f.pool, embedding: f.embedding });
  for (const method of [store.searchBM25.bind(store), store.searchNative.bind(store)]) {
    await expect(method(" ")).rejects.toMatchObject({ code: "InvalidData" });
    await expect(method("q", { topK: 0 })).rejects.toMatchObject({ code: "InvalidData" });
    await expect(method("q", { filter: {} })).rejects.toMatchObject({ code: "InvalidData" });
    await expect(method("q", { score_threshold: 0.5 } as never)).rejects.toMatchObject({ code: "InvalidData" });
  }
  expect(f.connect).not.toHaveBeenCalled();
});

it("returns BM25 matches without embedding and initializes its native index once", async () => {
  const f = fixture();
  const query = f.query.getMockImplementation()!;
  const match = { id: "saved", created_at: "2026-11-03T00:00:00.000Z", content, score: 2.5 };
  f.query.mockImplementation(async (sql, values) => {
    if (sql.includes("FROM pg_operator")) return { rows: [{ schema: "public" }], rowCount: 1 };
    if (sql.includes("pdb.score(")) return { rows: [match], rowCount: 1 };
    return query(sql, values);
  });
  const store = new PostgresqlVectorStore({ pool: f.pool, embedding: f.embedding });
  const expected = [{ id: match.id, createdAt: match.created_at, content, score: match.score }];
  expect(await store.searchBM25("hello")).toEqual(expected);
  expect(await store.searchBM25("hello", { topK: 1, filter: { metadata: { project: "handbook" } } })).toEqual(expected);
  expect(f.query.mock.calls.filter(([sql]) => sql.includes("USING bm25"))).toHaveLength(1);
  expect(f.embedding.embedQuery).not.toHaveBeenCalled();
  expect(f.embedding.embedDocuments).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledTimes(f.connect.mock.calls.length);
});

it.each(["XX000", "23505"])("preserves native %s write errors and releases the transaction client", async code => {
  const f = fixture(), failure = Object.assign(Error("write failed"), { code });
  const query = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, values) => {
    if (sql.includes("jsonb_to_recordset")) throw failure;
    return query(sql, values);
  });
  const store = new PostgresqlVectorStore({ pool: f.pool, embedding: f.embedding });
  await expect(store.insert([content])).rejects.toBe(failure);
  expect(f.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
  expect(f.release).toHaveBeenCalledTimes(f.connect.mock.calls.length);
  expect(f.end).not.toHaveBeenCalled();
});
