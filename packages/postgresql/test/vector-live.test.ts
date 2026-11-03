import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Content, EmbeddingModel } from "@tessar/rag";
import { PostgresqlVectorStore } from "../src/vector.js";

const connectionString = process.env.TESSAR_TEST_POSTGRES_URL;
let hasBM25 = false;
const resources: { schema: string; pool: Pool; stores: PostgresqlVectorStore[] }[] = [];
const content = (text: string, metadata: Content["metadata"] = {}): Content => ({
  text, format: "text", metadata,
});
function model(vectors: number[][] = [[1, 0]], modelId = "test"): EmbeddingModel {
  return {
    ref: { providerId: "test", modelId },
    embedDocuments: vi.fn(async (input: readonly (string | { text: string })[]) => input.map((_, index) => vectors[index % vectors.length]!)),
    embedQuery: vi.fn(async () => [1, 0]),
  };
}
function fixture(embedding = model()) {
  const schema = "tessar_test_" + randomUUID().replaceAll("-", "");
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
  const stores: PostgresqlVectorStore[] = [];
  resources.push({ schema, pool, stores });
  const connect = (collection = "default", nextModel = embedding) => {
    const store = new PostgresqlVectorStore({ pool, schema, collection, embedding: nextModel });
    stores.push(store);
    return store;
  };
  return { schema, pool, connect, store: connect() };
}
afterEach(async () => {
  for (const { schema, pool, stores } of resources.splice(0)) {
    try {
      await Promise.all(stores.map((store) => store.close()));
      if (!/^tessar_test_[a-f0-9]{32}$/.test(schema)) throw Error("Unsafe test schema cleanup");
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  }
});

describe.skipIf(!connectionString)("PostgreSQL vector (requires TESSAR_TEST_POSTGRES_URL)", () => {
  beforeAll(async () => {
    const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
    try {
      const result = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
      if (!result.rowCount) throw Error("TESSAR_TEST_POSTGRES_URL requires pgvector: enable CREATE EXTENSION vector in the test database");
      hasBM25 = !!(await pool.query("SELECT 1 FROM pg_extension WHERE extname='pg_search'")).rowCount;
      if (process.env.TESSAR_TEST_POSTGRES_BM25 === "1" && !hasBM25)
        throw Error("BM25 test database requires the pg_search extension to be enabled");
    } finally {
      await pool.end();
    }
  });

  it("persists ordered UUID records, original vectors and native HNSW across reopen", async () => {
    const vectors = [[0.123456789123, 1], [1, 0]];
    const embedding = model(vectors);
    const { store, connect, pool, schema } = fixture(embedding);
    expect(await store.info()).toEqual({ collection: "default", model: embedding.ref, dimensions: null });
    const contents = [content("first"), content("second")];
    const ids = await store.insert(contents);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    const records = await store.list();
    expect(records.map((record) => record.id)).toEqual(ids);
    expect(records.map((record) => record.content)).toEqual(contents);
    expect(records.map((record) => record.vector)).toEqual(vectors);
    expect(new Date(records[0]!.createdAt).toISOString()).toBe(records[0]!.createdAt);
    expect(await store.get(ids[0]!)).toEqual(records[0]);
    expect(await store.get(randomUUID())).toBeNull();
    const table = "tessar_v_" + createHash("sha256").update("default").digest("hex").slice(0, 40);
    const indexes = await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2", [schema, table]);
    expect(indexes.rows.some((row) => /USING hnsw.*vector_cosine_ops/i.test(row.indexdef))).toBe(true);
    await store.close();
    const reopened = connect();
    expect(await reopened.list()).toEqual(records);
    expect((await reopened.info()).dimensions).toBe(2);
    expect(await reopened.delete({ ids })).toBe(2);
    expect((await reopened.info()).dimensions).toBe(2);
    expect(await pool.query("SELECT 1 AS alive")).toMatchObject({ rows: [{ alive: 1 }] });
    await expect(store.info()).rejects.toMatchObject({ code: "InvalidState" });
  });

  it("matches typed JSON scalar filters, source fields and pagination for list/delete", async () => {
    const { store } = fixture();
    const first = { ...content("number", { value: 1, enabled: true, nullable: null }), source: { uri: "urn:test", page: 1 } };
    const ids = await store.insert([first, content("string", { value: "1" }), content("missing")]);
    expect((await store.list({ filter: { source: first.source, metadata: { value: 1, enabled: true, nullable: null } } })).map((record) => record.id)).toEqual([ids[0]]);
    expect((await store.list({ filter: { metadata: { value: "1" } } })).map((record) => record.id)).toEqual([ids[1]]);
    expect((await store.list({ filter: { metadata: { nullable: null } } })).map((record) => record.id)).toEqual([ids[0]]);
    expect((await store.list({ offset: 1, limit: 1 })).map((record) => record.id)).toEqual([ids[1]]);
    expect(await store.delete({ ids: [ids[0]!, ids[0]!, randomUUID()] })).toBe(1);
    expect(await store.delete({ filter: { metadata: { value: "1" } } })).toBe(1);
    expect((await store.list()).map((record) => record.id)).toEqual([ids[2]]);
  });

  it("ranks cosine scores and applies filters before topK with one query embedding", async () => {
    const embedding = model([[1, 0], [0, 1], [-1, 0]]);
    const { store } = fixture(embedding);
    const ids = await store.insert([content("near"), content("side", { selected: true }), content("opposite", { selected: true })]);
    const results = await store.search("question");
    expect(results.map((result) => result.id)).toEqual(ids);
    expect(results.map((result) => result.score)).toEqual([1, 0, -1]);
    expect(embedding.embedQuery).toHaveBeenCalledExactlyOnceWith("question");
    expect((await store.search("question", { topK: 1, filter: { metadata: { selected: true } } })).map((result) => result.id)).toEqual([ids[1]]);
    expect((await store.search("question", { score_threshold: 0 })).map((result) => result.id)).toEqual(ids.slice(0, 2));
  });

  it("runs native full-text with literal OR terms, filters and no model calls", async () => {
    const embedding = model();
    const { store, connect } = fixture(embedding);
    const ids = await store.insert([content("alpha alpha alpha", { keep: false }), content("beta", { keep: true }), content("unrelated")]);
    const results = await store.searchNative("alpha beta");
    expect(new Set(results.map(row => row.id))).toEqual(new Set(ids.slice(0, 2)));
    expect(results.every(row => Number.isFinite(row.score) && row.score > 0 && !("vector" in row))).toBe(true);
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
    expect((await store.searchNative("alpha beta", { topK: 1, filter: { metadata: { keep: true } } })).map(row => row.id)).toEqual([ids[1]]);
    expect(await store.searchNative("* : \" ()")).toEqual([]);
    expect(await connect().searchNative("alpha beta")).toEqual(results);
    await store.delete({ ids: [ids[0]!] });
    expect(await store.searchNative("alpha")).toEqual([]);
    expect(embedding.embedQuery).not.toHaveBeenCalled();
    expect(embedding.embedDocuments).toHaveBeenCalledTimes(1);
  });

  it("uses native BM25 indexing when enabled and rejects only BM25 when absent", async () => {
    const embedding = model();
    const { store, connect } = fixture(embedding);
    const ids = await store.insert([content("alpha alpha", { keep: false }), content("alpha beta", { keep: true }), content("unrelated")]);
    if (!hasBM25) {
      await expect(store.searchBM25("alpha")).rejects.toMatchObject({ code: "InvalidConfiguration" });
      expect(await store.searchNative("alpha")).toHaveLength(2);
      expect(await store.list()).toHaveLength(3);
      return;
    }
    const results = await store.searchBM25("alpha");
    expect(new Set(results.map(row => row.id))).toEqual(new Set(ids.slice(0, 2)));
    expect(results.every(row => Number.isFinite(row.score) && !("vector" in row))).toBe(true);
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
    expect((await store.searchBM25("alpha", { topK: 1, filter: { metadata: { keep: true } } })).map(row => row.id)).toEqual([ids[1]]);
    const [later] = await store.insert([content("alpha later")]);
    expect((await connect().searchBM25("alpha later")).map(row => row.id)).toContain(later);
    await store.delete({ ids: [ids[0]!] });
    expect((await store.searchBM25("alpha")).map(row => row.id)).not.toContain(ids[0]);
    expect(embedding.embedQuery).not.toHaveBeenCalled();
  });

  it("isolates schemas and collections including hostile collection strings", async () => {
    const { store, connect } = fixture();
    const other = connect("x'; DROP SCHEMA public CASCADE; --");
    const isolated = fixture().store;
    const [id] = await store.insert([content("private")]);
    await other.insert([content("other")]);
    expect(await other.get(id!)).toBeNull();
    expect(await isolated.get(id!)).toBeNull();
    expect((await store.list()).map((record) => record.content.text)).toEqual(["private"]);
  });

  it("serializes first inserts across handles and rejects conflicting dimensions/model", async () => {
    const { store, connect } = fixture();
    const peer = connect();
    const inserted = await Promise.all([store.insert([content("first")]), peer.insert([content("second")])]);
    expect((await store.list()).map((record) => record.id).sort()).toEqual(inserted.flat().sort());
    const wrongDimensions = connect("default", model([[1, 0, 0]]));
    await expect(wrongDimensions.insert([content("bad")])).rejects.toMatchObject({ code: "InvalidData" });
    const wrongModel = connect("default", model([[1, 0]], "different"));
    await expect(wrongModel.info()).rejects.toMatchObject({ code: "InvalidConfiguration" });
    expect(await store.list()).toHaveLength(2);
  });

  it("leaves no writes on provider failure or invalid vector batches", async () => {
    const failure = Error("provider failed");
    const embedding = model();
    const { store } = fixture(embedding);
    vi.mocked(embedding.embedDocuments).mockRejectedValueOnce(failure);
    await expect(store.insert([content("failed")])).rejects.toBe(failure);
    vi.mocked(embedding.embedDocuments).mockResolvedValueOnce([[1, 0], [1, 0, 0]]);
    await expect(store.insert([content("one"), content("two")])).rejects.toMatchObject({ code: "InvalidData" });
    expect(await store.list()).toEqual([]);
    expect((await store.info()).dimensions).toBeNull();
    await store.insert([content("works")]);
    expect(await store.list()).toHaveLength(1);
  });

  it("allows only one dimension winner during conflicting first inserts", async () => {
    const { store, connect } = fixture();
    const peer = connect("default", model([[1, 0, 0]]));
    const results = await Promise.allSettled([
      store.insert([content("two dimensions")]),
      peer.insert([content("three dimensions")]),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "InvalidData" },
    });
    const records = await store.list();
    expect(records).toHaveLength(1);
    expect((await store.info()).dimensions).toBe(records[0]!.vector.length);
  });

  it("rolls back native HNSW dimension errors and keeps the connection usable", async () => {
    const { store, pool } = fixture(model([Array.from({ length: 2001 }, () => 1)]));
    await expect(store.insert([content("too wide")])).rejects.toThrow(/2000|dimensions/i);
    expect((await store.info()).dimensions).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(await pool.query("SELECT 1 AS alive")).toMatchObject({ rows: [{ alive: 1 }] });
  });
});
