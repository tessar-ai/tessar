import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { MongoClient } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chunk, Content, EmbeddingModel } from "@tessar/rag";
import { MongoDBVectorStore } from "../src/vector.js";

const uri = process.env.TESSAR_TEST_MONGODB_URL;
const searchUri = process.env.TESSAR_TEST_MONGODB_SEARCH_URL;
const resources: { client: MongoClient; databaseName: string; stores: MongoDBVectorStore[] }[] = [];
const content = (text: string, metadata: Content["metadata"] = {}): Content => ({ text, format: "text", metadata });
function model(vectors: number[][] = [[1, 0]], modelId = "test"): EmbeddingModel {
  return {
    ref: { providerId: "test", modelId },
    embedDocuments: vi.fn(async (input: readonly (string | { text: string })[]) => input.map((_, index) => vectors[index % vectors.length]!)),
    embedQuery: vi.fn(async () => [1, 0]),
  };
}
async function fixture(embedding = model(), endpoint = uri!) {
  const client = new MongoClient(endpoint, { serverSelectionTimeoutMS: 5000 });
  const databaseName = "tessar_test_" + randomUUID().replaceAll("-", "");
  const stores: MongoDBVectorStore[] = [];
  resources.push({ client, databaseName, stores });
  await client.connect();
  const database = client.db(databaseName);
  const connect = (collection = "default", nextModel = embedding, namespace = "tessar") => {
    const store = new MongoDBVectorStore({ database, embedding: nextModel, collection, namespace });
    stores.push(store);
    return store;
  };
  return { client, database, connect, store: connect() };
}
afterEach(async () => {
  for (const { client, databaseName, stores } of resources.splice(0)) {
    try {
      await Promise.all(stores.map(store => store.close()));
      if (!/^tessar_test_[a-f0-9]{32}$/.test(databaseName)) throw Error("Unsafe test database cleanup");
      await client.db(databaseName).dropDatabase();
    } finally {
      await client.close();
    }
  }
});

// Search indexes and their visibility are asynchronous; only tests wait for them.
async function visible<T>(query: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 90000;
  for (; ;) {
    try {
      const value = await query();
      if (ready(value)) return value;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "InvalidState")) throw error;
    }
    if (Date.now() >= deadline) throw Error("MongoDB Search index/visibility did not become ready within 90 seconds");
    await delay(500);
  }
}

describe.skipIf(!uri)("MongoDB vector (requires TESSAR_TEST_MONGODB_URL)", () => {
  it("persists original content/chunks, exact vectors and insertion order while borrowing its client", async () => {
    const vectors = [[0.123456789123, 1], [1, 0]];
    const embedding = model(vectors);
    const { store, connect, database } = await fixture(embedding);
    expect(await store.info()).toEqual({ collection: "default", model: embedding.ref, dimensions: null });
    const chunk: Chunk = { ...content("second", { nested: { values: [1, null, true] } }), format: "markdown", source: { uri: "urn:test", page: 2 }, position: { contentIndex: 3, start: 1, end: 7 } };
    const contents = [content("first"), chunk];
    const ids = await store.insert(contents);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    const records = await store.list();
    expect(records.map(row => row.id)).toEqual(ids);
    expect(records.map(row => row.content)).toEqual(contents);
    expect(records.map(row => row.vector)).toEqual(vectors);
    expect(new Date(records[0]!.createdAt).toISOString()).toBe(records[0]!.createdAt);
    expect(await store.get(ids[0]!)).toEqual(records[0]);
    expect(await store.get(randomUUID())).toBeNull();
    await store.close();
    await store.close();
    expect(await database.command({ ping: 1 })).toMatchObject({ ok: 1 });
    await expect(store.info()).rejects.toMatchObject({ code: "InvalidState" });
    const reopened = connect();
    expect(await reopened.list()).toEqual(records);
    expect((await reopened.info()).dimensions).toBe(2);
    expect(await reopened.delete({ ids })).toBe(2);
    expect((await reopened.info()).dimensions).toBe(2);
    expect(await connect("other").list()).toEqual([]);
    expect(await connect("default", embedding, "other").list()).toEqual([]);
  });

  it("matches typed scalar filters, null rather than missing, arbitrary keys and source fields", async () => {
    const { store } = await fixture();
    const first = { ...content("number", { value: 1, enabled: true, nullable: null, "x.$key": false }), source: { uri: "urn:test", page: 1 } };
    const ids = await store.insert([first, content("string", { value: "1", enabled: "true", "x.$key": "false" }), content("missing")]);
    expect((await store.list({ filter: { source: first.source, metadata: { value: 1, enabled: true, nullable: null, "x.$key": false } } })).map(row => row.id)).toEqual([ids[0]]);
    expect((await store.list({ filter: { metadata: { value: "1" } } })).map(row => row.id)).toEqual([ids[1]]);
    expect((await store.list({ filter: { metadata: { nullable: null } } })).map(row => row.id)).toEqual([ids[0]]);
    expect((await store.list({ offset: 1, limit: 1 })).map(row => row.id)).toEqual([ids[1]]);
    expect(await store.delete({ ids: [ids[0]!, ids[0]!, randomUUID()] })).toBe(1);
    expect(await store.delete({ filter: { metadata: { value: "1" } } })).toBe(1);
    expect((await store.list()).map(row => row.id)).toEqual([ids[2]]);
  });

  it("runs native text OR searches with filters and no query embedding or mongot", async () => {
    const embedding = model();
    const { store, connect } = await fixture(embedding);
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

  it("leaves dimensions unset after provider or invalid batch failures", async () => {
    const embedding = model();
    const { store } = await fixture(embedding);
    const failure = Error("provider failed");
    vi.mocked(embedding.embedDocuments).mockRejectedValueOnce(failure);
    await expect(store.insert([content("failed")])).rejects.toBe(failure);
    vi.mocked(embedding.embedDocuments).mockResolvedValueOnce([[1, 0], [1, 0, 0]]);
    await expect(store.insert([content("one"), content("two")])).rejects.toMatchObject({ code: "InvalidData" });
    expect(await store.list()).toEqual([]);
    expect((await store.info()).dimensions).toBeNull();
    await store.insert([content("works")]);
    expect(await store.list()).toHaveLength(1);
  });

  it("rolls back a native batch write failure and keeps the borrowed client usable", async () => {
    const { store, database } = await fixture();
    const [id] = await store.insert([content("retained")]);
    const names = await database.listCollections({}, { nameOnly: true }).toArray();
    const name = (await Promise.all(names.map(async row => ({ name: row.name, found: await database.collection<{ _id: string; id?: string }>(row.name).findOne({ $or: [{ id }, { _id: id }] }) })))).find(row => row.found)?.name;
    expect(name).toBeDefined();
    await database.command({ collMod: name!, validator: { forbidden: { $exists: true } }, validationLevel: "strict" });
    await expect(store.insert([content("one"), content("two")])).rejects.toMatchObject({ code: 121 });
    expect((await store.list()).map(row => row.id)).toEqual([id]);
    expect((await store.info()).dimensions).toBe(2);
    await database.command({ collMod: name!, validator: {} });
    await store.insert([content("works")]);
    expect(await store.list()).toHaveLength(2);
  });

  it("serializes same-model first inserts and rejects conflicting model identities", async () => {
    const { store, connect } = await fixture();
    const peer = connect();
    const results = await Promise.all([store.insert([content("first")]), peer.insert([content("second")])]);
    expect((await store.list()).map(row => row.id).sort()).toEqual(results.flat().sort());
    await expect(connect("default", model([[1, 0]], "different")).info()).rejects.toMatchObject({ code: "InvalidConfiguration" });
    await expect(connect("default", model([[1, 0, 0]])).insert([content("bad")])).rejects.toMatchObject({ code: "InvalidData" });
    expect(await store.list()).toHaveLength(2);
  });

  it("allows exactly one dimension winner during conflicting first inserts", async () => {
    const { store, connect } = await fixture();
    const peer = connect("default", model([[1, 0, 0]]));
    const results = await Promise.allSettled([store.insert([content("two")]), peer.insert([content("three")])]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(results.find(row => row.status === "rejected")).toMatchObject({ reason: { code: "InvalidData" } });
    const records = await store.list();
    expect(records).toHaveLength(1);
    expect((await store.info()).dimensions).toBe(records[0]!.vector.length);
  });

  it("allows exactly one model identity winner across competing handles", async () => {
    const { store, connect } = await fixture();
    const peer = connect("default", model([[1, 0]], "other"));
    const results = await Promise.allSettled([store.insert([content("first")]), peer.insert([content("second")])]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(results.find(row => row.status === "rejected")).toMatchObject({ reason: { code: "InvalidConfiguration" } });
    const winner = results[0]!.status === "fulfilled" ? store : peer;
    expect(await winner.list()).toHaveLength(1);
    expect((await winner.info()).dimensions).toBe(2);
  });
});

describe.skipIf(!searchUri)("MongoDB Search vector (requires TESSAR_TEST_MONGODB_SEARCH_URL with mongot)", () => {
  it("ranks exact cosine and applies dynamic token-array filters before topK", async () => {
    const embedding = model([[1, 0], [0, 1], [-1, 0]]);
    const { store } = await fixture(embedding, searchUri!);
    const ids = await store.insert([content("near"), content("side", { selected: true, "x.$key": null }), content("opposite", { selected: true, "x.$key": null })]);
    const results = await visible(() => store.search("question"), rows => rows.length === 3);
    expect(results.map(row => row.id)).toEqual(ids);
    results.forEach((row, index) => expect(row.score).toBeCloseTo([1, 0, -1][index]!, 6));
    expect((await store.search("question", { topK: 1, filter: { metadata: { selected: true, "x.$key": null } } })).map(row => row.id)).toEqual([ids[1]]);
    expect((await store.search("question", { score_threshold: 0 })).map(row => row.id)).toEqual(ids.slice(0, 2));
    const calls = vi.mocked(embedding.embedQuery).mock.calls.length;
    await store.search("once");
    expect(embedding.embedQuery).toHaveBeenCalledTimes(calls + 1);
    const [later] = await store.insert([content("later", { "late.$key": true })]);
    await visible(() => store.search("question", { topK: 1, filter: { metadata: { "late.$key": true } } }), rows => rows[0]?.id === later);
    await store.delete({ ids: [later!] });
    await visible(() => store.search("question", { filter: { metadata: { "late.$key": true } } }), rows => rows.length === 0);
  }, 300000);

  it("uses BM25 with prefilters and unchanged index definitions for later metadata keys and deletes", async () => {
    const embedding = model();
    const { store, database, connect } = await fixture(embedding, searchUri!);
    const ids = await store.insert([content("alpha alpha alpha", { keep: false }), content("alpha beta", { keep: true }), content("unrelated")]);
    const results = await visible(() => store.searchBM25("alpha"), rows => rows.length === 2).catch(async error => {
      const collections = await database.listCollections({}, { nameOnly: true }).toArray();
      for (const { name } of collections) {
        const indexes = await database.collection(name).aggregate<{ name: string; latestDefinition: unknown }>([{ $listSearchIndexes: {} }]).toArray();
        if (indexes.length) console.error("MongoDB Search definitions:", JSON.stringify(indexes.map(index => ({ name: index.name, definition: index.latestDefinition }))));
      }
      throw error;
    });
    expect(new Set(results.map(row => row.id))).toEqual(new Set(ids.slice(0, 2)));
    expect(results.every(row => Number.isFinite(row.score) && !("vector" in row))).toBe(true);
    expect((await store.searchBM25("alpha", { topK: 1, filter: { metadata: { keep: true } } })).map(row => row.id)).toEqual([ids[1]]);
    const definitions = async () => {
      const names = await database.listCollections({}, { nameOnly: true }).toArray();
      const indexes = await Promise.all(names.map(async row => ({ collection: row.name, indexes: (await database.collection(row.name).aggregate<{ name: string; latestDefinition: unknown }>([{ $listSearchIndexes: {} }]).toArray()).map(index => ({ name: index.name, definition: index.latestDefinition })) })));
      return indexes.sort((a, b) => a.collection.localeCompare(b.collection));
    };
    const before = await definitions();
    const [later] = await store.insert([{ ...content("alpha later", { "new.$key": null, keep: true }), source: { uri: "urn:later", page: 9 } }]);
    const peer = connect();
    await visible(() => peer.searchBM25("alpha", { topK: 1, filter: { metadata: { "new.$key": null, keep: true }, source: { uri: "urn:later", page: 9 } } }), rows => rows[0]?.id === later);
    expect(await definitions()).toEqual(before);
    await store.delete({ ids: [ids[0]!] });
    await visible(() => store.searchBM25("alpha"), rows => !rows.some(row => row.id === ids[0]) && rows.some(row => row.id === later));
    expect(embedding.embedQuery).not.toHaveBeenCalled();
  }, 300000);
});
