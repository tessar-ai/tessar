import { describe, expect, it, vi } from "vitest";
import { MongoServerError, type Db } from "mongodb";
import { MongoDBVectorStore } from "../src/vector.js";

function fixture() {
  const collections = new Map<string, any>();
  const client = { startSession: vi.fn(), connect: vi.fn(), close: vi.fn() };
  const session = {
    withTransaction: vi.fn(async (action: () => Promise<unknown>) => {
      const snapshots = new Map([...collections].map(([name, c]) => [name, structuredClone(c.rows)]));
      try { return await action(); }
      catch (error) { for (const [name, rows] of snapshots) collections.get(name).rows = rows; throw error; }
    }),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  client.startSession.mockReturnValue(session);
  const matches = (row: any, filter: any): boolean => Object.entries(filter).every(([key, value]: any) => {
    if (key === "$text") return true;
    if (value?.$in) return value.$in.includes(row[key]);
    if (value?.$all) return value.$all.every((v: string) => row[key].includes(v));
    return row[key] === value;
  });
  const db = {
    client, createCollection: vi.fn().mockResolvedValue(undefined), collection: vi.fn((name: string) => {
      if (!collections.has(name)) {
        const c: any = {
          collectionName: name, rows: [], indexes: [], pipeline: [], results: [],
          createIndex: vi.fn().mockResolvedValue("index"),
          findOne: vi.fn(async (filter: any) => structuredClone(c.rows.find((r: any) => matches(r, filter)) ?? null)),
          updateOne: vi.fn(async (filter: any, update: any) => {
            let row = c.rows.find((r: any) => matches(r, filter));
            if (!row) { row = { ...filter, ...update.$setOnInsert }; c.rows.push(row); }
            Object.assign(row, update.$set); for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] += value;
            return { matchedCount: 1 };
          }),
          insertMany: vi.fn(async (rows: any[]) => { c.rows.push(...structuredClone(rows)); }),
          find: vi.fn((filter: any) => {
            let rows = c.rows.filter((r: any) => matches(r, filter));
            const cursor: any = {
              sort: vi.fn(() => cursor), skip: vi.fn((n: number) => { rows = rows.slice(n); return cursor; }),
              limit: vi.fn((n: number) => { rows = rows.slice(0, n); return cursor; }), toArray: vi.fn(async () => structuredClone(rows))
            };
            return cursor;
          }),
          deleteMany: vi.fn(async (filter: any) => { const count = c.rows.length; c.rows = c.rows.filter((r: any) => !matches(r, filter)); return { deletedCount: count - c.rows.length }; }),
          listSearchIndexes: vi.fn(() => ({ toArray: async () => c.indexes })),
          createSearchIndex: vi.fn(async (index: any) => { c.indexes.push({ ...index, latestDefinition: index.definition, queryable: false, status: "READY" }); return index.name; }),
          aggregate: vi.fn((pipeline: any[]) => { c.pipeline = pipeline; return { toArray: async () => c.results }; }),
        };
        collections.set(name, c);
      }
      return collections.get(name);
    })
  };
  const embedding = { ref: { providerId: "test", modelId: "v1" }, embedDocuments: vi.fn(async (contents: readonly unknown[]) => contents.map(() => [1, 0])), embedQuery: vi.fn(async () => [1, 0]) };
  const store = new MongoDBVectorStore({ database: db as unknown as Db, embedding });
  const content = { text: "hello world", format: "text" as const, metadata: { "a.$b": null, nested: { a: 1 } }, source: { uri: "doc", page: 1 } };
  const data = () => [...collections.values()].find(c => c.collectionName !== "tessar_vector_collections");
  return { store, db, collections, client, session, embedding, content, data };
}

describe("MongoDBVectorStore", () => {
  it("initializes only vector collections without creating state collections", async () => {
    const f = fixture();
    expect(f.db.createCollection).not.toHaveBeenCalled();
    await f.store.info();
    expect([...f.collections.keys()]).toHaveLength(2);
    expect(f.db.createCollection.mock.calls.map(call => call[0])).toEqual([...f.collections.keys()]);
    expect([...f.collections.keys()]).not.toContain("tessar_checkpoints");
  });

  it("retains originals, freezes identity and allocates ordered atomic batches without Search", async () => {
    const f = fixture();
    expect(await f.store.info()).toMatchObject({ collection: "default", dimensions: null });
    const ids = await f.store.insert([f.content, { ...f.content, text: "second" }]);
    expect(ids).toHaveLength(2);
    expect(await f.store.get(ids[0]!)).toMatchObject({ id: ids[0], content: f.content, vector: [1, 0] });
    expect((await f.store.list()).map(r => r.id)).toEqual(ids);
    expect(await f.store.info()).toMatchObject({ dimensions: 2 });
    expect(f.data().rows[0].filterTokens).toContain('["metadata","a.$b",null]');
    expect(f.data().rows[0].filterTokens).not.toContain('["metadata","nested",{"a":1}]');
    expect(f.data().createSearchIndex).not.toHaveBeenCalled();
    expect(f.session.endSession).toHaveBeenCalledTimes(1);
    await f.store.close(); await f.store.close();
    await expect(f.store.get(ids[0]!)).rejects.toMatchObject({ code: "InvalidState" });
    expect(f.client.connect).not.toHaveBeenCalled(); expect(f.client.close).not.toHaveBeenCalled();
  });

  it("rolls metadata back on bulk failure and preserves native error identity", async () => {
    const f = fixture(); await f.store.info();
    const error = new MongoServerError({ message: "duplicate", code: 11000 }); f.data().insertMany.mockRejectedValueOnce(error);
    await expect(f.store.insert([f.content])).rejects.toBe(error);
    expect(await f.store.info()).toMatchObject({ dimensions: null });
    expect(await f.store.list()).toEqual([]);
    expect(f.session.endSession).toHaveBeenCalledOnce();
    await f.store.insert([f.content]);
    expect(f.data().rows[0].sequence).toBe(1);
  });

  it("snapshots content and rejects changed identity after provider await", async () => {
    const f = fixture(); let finish!: (v: number[][]) => void;
    f.embedding.embedDocuments.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const inserting = f.store.insert([f.content]);
    await vi.waitFor(() => expect(f.embedding.embedDocuments).toHaveBeenCalled());
    f.content.text = "mutated"; f.embedding.ref.modelId = "v2"; finish([[1, 0]]);
    await expect(inserting).rejects.toMatchObject({ code: "InvalidConfiguration" });
    expect(f.data().rows).toEqual([]);
    expect(f.embedding.embedDocuments.mock.calls[0]![0][0]).toMatchObject({ text: "hello world" });
  });

  it("uses typed AND tokens for list and delete without interpreting arbitrary keys", async () => {
    const f = fixture(); const ids = await f.store.insert([f.content, { ...f.content, metadata: {} }]);
    expect((await f.store.list({ filter: { metadata: { "a.$b": null }, source: { page: 1 } } })).map(r => r.id)).toEqual([ids[0]]);
    expect(await f.store.delete({ filter: { metadata: { "a.$b": null } } })).toBe(1);
    expect((await f.store.list()).map(r => r.id)).toEqual([ids[1]]);
  });

  it("checks vector index readiness each call and filters before exact topK", async () => {
    const f = fixture(); const [id] = await f.store.insert([f.content]);
    await expect(f.store.search("hello")).rejects.toMatchObject({ code: "InvalidState" });
    expect(f.embedding.embedQuery).not.toHaveBeenCalled();
    const index = f.data().indexes[0]; expect(index.type).toBe("vectorSearch"); index.queryable = true;
    delete index.type;
    f.data().results = [{ _id: id, score: 0.75 }, { _id: "deleted", score: 1 }];
    const result = await f.store.search("hello", { topK: 2, score_threshold: 0.5, filter: { metadata: { "a.$b": null } } });
    expect(result).toEqual([expect.objectContaining({ id, score: 0.5, content: f.content })]);
    expect(f.data().pipeline[0]).toEqual({ $vectorSearch: expect.objectContaining({ exact: true, limit: 2, filter: { $and: [{ filterTokens: { $eq: '["metadata","a.$b",null]' } }] } }) });
    expect(f.data().pipeline[0].$vectorSearch).not.toHaveProperty("numCandidates");
    index.queryable = false;
    await expect(f.store.search("hello")).rejects.toMatchObject({ code: "InvalidState" });
    index.queryable = true; index.status = "BUILDING";
    await expect(f.store.search("hello")).rejects.toMatchObject({ code: "InvalidState" });
    index.status = "READY";
    index.latestDefinitionVersion = { version: 2 };
    index.statusDetail = [{ status: "READY", queryable: true, mainIndex: { status: "READY", queryable: true, definitionVersion: { version: 1 } } }];
    await expect(f.store.search("hello")).rejects.toMatchObject({ code: "InvalidState" });
    index.statusDetail[0].mainIndex.definitionVersion.version = 2;
    await expect(f.store.search("hello")).resolves.toHaveLength(1);
    index.latestDefinition = { fields: [] };
    await expect(f.store.search("hello")).rejects.toMatchObject({ code: "InvalidConfiguration" });
    expect(f.data().createSearchIndex).toHaveBeenCalledOnce();
  });

  it("uses explicit BM25/token mapping and never embeds lexical searches", async () => {
    const f = fixture(); await f.store.insert([f.content]);
    await expect(f.store.searchBM25("hello")).rejects.toMatchObject({ code: "InvalidState" });
    const index = f.data().indexes[0]; expect(index.definition.mappings.fields.text.similarity).toEqual({ type: "bm25" }); index.queryable = true;
    await f.store.searchBM25("hello -world", { filter: { source: { page: 1 } } });
    expect(f.data().pipeline[0].$search.compound.filter).toEqual([{ equals: { path: "filterTokens", value: '["source","page",1]' } }]);
    await f.store.searchNative('hello -world "phrase"');
    expect(f.data().createIndex).toHaveBeenCalledWith({ text: "text" }, { name: "tessar_native", default_language: "none" });
    expect(f.embedding.embedQuery).not.toHaveBeenCalled();
    expect(f.session.withTransaction).toHaveBeenCalledOnce();
  });

  it("accepts MongoDB's explicit default string mapping and rejects changed scoring fields", async () => {
    const f = fixture(); await f.store.insert([f.content]);
    await expect(f.store.searchBM25("hello")).rejects.toMatchObject({ code: "InvalidState" });
    const index = f.data().indexes[0];
    index.latestDefinition = structuredClone(index.definition);
    Object.assign(index.latestDefinition.mappings.fields.text, { indexOptions: "offsets", store: true, norms: "include" });
    index.queryable = true;
    await expect(f.store.searchBM25("hello")).resolves.toEqual([]);
    index.latestDefinition.mappings.fields.text.norms = "omit";
    await expect(f.store.searchBM25("hello")).rejects.toMatchObject({ code: "InvalidConfiguration" });
  });

  it("rejects oversized tokens and invalid options before any provider I/O", async () => {
    const f = fixture();
    await expect(f.store.insert([{ ...f.content, metadata: { huge: "é".repeat(17000) } }])).rejects.toMatchObject({ code: "InvalidData" });
    await expect(f.store.search("x", { score_threshold: 2 })).rejects.toMatchObject({ code: "InvalidData" });
    await expect(f.store.list({ filter: { metadata: { bad: [] } } } as any)).rejects.toMatchObject({ code: "InvalidData" });
    expect(f.embedding.embedDocuments).not.toHaveBeenCalled(); expect(f.embedding.embedQuery).not.toHaveBeenCalled();
  });

  it("accepts a concurrent compatible search-index creator and preserves other native errors", async () => {
    const f = fixture(); await f.store.insert([f.content]);
    f.data().createSearchIndex.mockImplementationOnce(async (index: any) => {
      f.data().indexes.push({ ...index, latestDefinition: index.definition, queryable: true, status: "READY" });
      throw new MongoServerError({ message: "index already exists", code: 68 });
    });
    expect(await f.store.search("hello")).toEqual([]);
    const missingSearch = new MongoServerError({ message: "Search not enabled", code: 31082 });
    f.data().listSearchIndexes.mockImplementationOnce(() => ({ toArray: async () => { throw missingSearch; } }));
    f.embedding.embedQuery.mockClear();
    await expect(f.store.search("hello")).rejects.toBe(missingSearch);
    expect(f.embedding.embedQuery).not.toHaveBeenCalled();
  });

  it("rejects different dimensions without changing committed data and always passes the session", async () => {
    const f = fixture(); await f.store.insert([f.content]);
    f.embedding.embedDocuments.mockResolvedValueOnce([[1, 0, 0]]);
    await expect(f.store.insert([f.content])).rejects.toMatchObject({ code: "InvalidData" });
    expect((await f.store.list())).toHaveLength(1);
    expect(f.data().insertMany).toHaveBeenCalledWith(expect.any(Array), { session: f.session, ordered: true });
    expect(f.session.withTransaction).toHaveBeenCalledWith(expect.any(Function), {
      readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary",
    });
    expect(f.session.endSession).toHaveBeenCalledTimes(2);
  });

  it("keeps namespaces and logical collections isolated and refuses a mismatched saved model", async () => {
    const f = fixture(); await f.store.insert([f.content]);
    const namespaced = new MongoDBVectorStore({ database: f.db as unknown as Db, embedding: f.embedding, namespace: "other" });
    const other = new MongoDBVectorStore({ database: f.db as unknown as Db, embedding: f.embedding, collection: "other" });
    expect(await namespaced.list()).toEqual([]); expect(await other.list()).toEqual([]);
    expect([...f.collections.keys()]).toContain("other_tessar_vector_collections");
    const mismatch = new MongoDBVectorStore({ database: f.db as unknown as Db, embedding: { ...f.embedding, ref: { providerId: "test", modelId: "v2" } } });
    await expect(mismatch.info()).rejects.toMatchObject({ code: "InvalidConfiguration" });
    expect(f.client.close).not.toHaveBeenCalled();
  });

  it("preserves provider and transaction failures even if session cleanup fails", async () => {
    const f = fixture(); const providerError = new Error("provider");
    f.embedding.embedDocuments.mockRejectedValueOnce(providerError);
    await expect(f.store.insert([f.content])).rejects.toBe(providerError);
    expect(f.client.startSession).not.toHaveBeenCalled();
    const driverError = new Error("write"); f.data().insertMany.mockRejectedValueOnce(driverError);
    f.session.endSession.mockRejectedValueOnce(new Error("cleanup"));
    await expect(f.store.insert([f.content])).rejects.toBe(driverError);
  });

  it.each(["", "invalid-name", "x.y", "1first", "x".repeat(64)])("validates namespace %j before touching database", namespace => {
    const f = fixture(); f.db.collection.mockClear();
    expect(() => new MongoDBVectorStore({ database: f.db as unknown as Db, embedding: f.embedding, namespace })).toThrow(expect.objectContaining({ code: "InvalidConfiguration" }));
    expect(f.db.collection).not.toHaveBeenCalled();
  });
});
