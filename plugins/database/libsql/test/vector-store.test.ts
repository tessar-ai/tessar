import { createTestDatabase } from "./database-fixture.js";
import { createTestStore, insert as insertVectors, search as searchVector } from "./embedding-fixture.js";
import { removeSqliteTestDirectory as rm } from "../../../../tests/helpers/sqlite-cleanup.js";
import DatabaseSync from "libsql";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { DocumentReader, DocumentSplitter, TessarRagError, type Content } from "@tessar/rag";
import * as sqlite from "../src/index.js";

const content = (text: string): Content => ({ text, format: "text", metadata: {} });
const open = (options = {}) => {
  const store = createTestStore({ filename: ":memory:", dimensions: 2, ...options });
  onTestFinished(() => store.close());
  return store;
};
async function file() {
  const directory = await mkdtemp(join(tmpdir(), "tessar-vector-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return join(directory, "vectors.db");
}

it("accepts reader/splitter output directly and rediscovers IDs and UTC dates after reopening", async () => {
  const filename = await file();
  const contents = await new DocumentReader().load({ source: { text: "abcdef" } }).result();
  const chunks = new DocumentSplitter({ strategy: "character", maxSize: 3 }).chunk(contents);
  const store = open({ filename });
  const before = Date.now();
  const ids = await insertVectors(store, { contents: chunks, vectors: [[1, 2], [3, 4]] });
  const records = await store.list();
  expect(new Set(ids).size).toBe(2);
  expect(records.map(record => record.id)).toEqual(ids);
  expect(records.map(record => record.content)).toEqual(chunks);
  expect(records.map(record => record.vector)).toEqual([[1, 2], [3, 4]]);
  for (const record of records) {
    expect(record.id).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
    expect(record.createdAt).toMatch(/Z$/);
    expect(Date.parse(record.createdAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(record.createdAt)).toBeLessThanOrEqual(Date.now());
  }
  await store.close();
  const reopened = open({ filename });
  expect(await reopened.list()).toEqual(records);
  expect(await reopened.get(records[0]!.id)).toEqual(records[0]);
  expect(await reopened.delete({ ids: [records[0]!.id] })).toBe(1);
  expect(await reopened.get(records[0]!.id)).toBeNull();
  expect(await reopened.get("missing")).toBeNull();
});

it("isolates collections and files, and refuses to change existing dimensions", async () => {
  const filename = await file();
  const a = open({ filename, collection: "a'; DROP TABLE nope;--" });
  const b = open({ filename, collection: "b" });
  const separate = open({ filename: filename + ".other" });
  const [id] = await insertVectors(a, { contents: [content("kept")], vectors: [[1, 2]] });
  expect(await b.get(id!)).toBeNull();
  expect(await b.delete({ ids: [id!] })).toBe(0);
  expect(await b.list()).toEqual([]);
  expect(await separate.list()).toEqual([]);
  const mismatched = open({ filename, collection: "a'; DROP TABLE nope;--", dimensions: 3 });
  await expect(mismatched.insert([content("wrong dimensions")])).rejects.toThrow(TessarRagError);
  expect((await a.get(id!))?.content.text).toBe("kept");
});

it("rejects text filters for list/delete without removing records", async () => {
  const store = open();
  await insertVectors(store, { contents: [content("keep")], vectors: [[1, 2]] });
  const filter = { text: "keep", metadata: { project: "handbook" } };
  await expect(store.list({ filter } as never)).rejects.toMatchObject({ code: "InvalidData" });
  await expect(store.delete({ filter } as never)).rejects.toMatchObject({ code: "InvalidData" });
  expect(await store.list()).toHaveLength(1);
});

it("filters saved source/metadata, pages in insertion order and deletes without retained IDs", async () => {
  const store = open();
  await insertVectors(store, {
    contents: [
      { ...content("literal %_ guide"), source: { uri: "file:///manual.pdf", page: 3 }, metadata: { kind: "manual", active: true, n: 1, absent: null } },
      { ...content("other guide"), source: { uri: "file:///manual.pdf", page: 4 }, metadata: { kind: "manual", active: false, n: "1" } },
      content("last"),
    ],
    vectors: [[1, 2], [2, 3], [3, 4]],
  });
  expect((await store.list({ filter: { source: { page: 4 } } })).map(r => r.content.text)).toEqual(["other guide"]);
  expect((await store.list({ filter: { metadata: { active: true, n: 1, absent: null } } })).length).toBe(1);
  expect((await store.list({ filter: { metadata: { n: "1" } } })).length).toBe(1);
  expect(await store.list({ filter: { metadata: { missing: null } } })).toEqual([]);
  expect((await store.list({ limit: 1, offset: 1 }))[0]?.content.text).toBe("other guide");
  expect(await store.list({ offset: 100 })).toEqual([]);
  expect(await store.delete({ filter: { source: { uri: "file:///manual.pdf" }, metadata: { kind: "manual" } } })).toBe(2);
  expect((await store.list()).map(r => r.content.text)).toEqual(["last"]);
  expect(await store.delete({ filter: { source: { uri: "' OR 1=1 --" } } })).toBe(0);
});

it("preserves JSON types and literal metadata keys in filter predicates", async () => {
  const store = open();
  await insertVectors(store, {
    contents: [
      { ...content("a"), metadata: { 'a".$': false, x: 0 } },
      { ...content("b"), metadata: { 'a".$': 0, x: false } },
    ], vectors: [[1, 2], [3, 4]]
  });
  expect((await store.list({ filter: { metadata: { 'a".$': false, x: 0 } } })).map(r => r.content.text)).toEqual(["a"]);
});

it.each([
  {}, { ids: [] }, { ids: [""] }, { ids: ["a"], filter: { text: "x" } },
  { filter: {} }, { filter: { text: "" } }, { filter: { source: {} } },
  { filter: { metadata: {} } }, { filter: { metadata: { n: {} } } },
  { filter: { typo: true } }, { filter: { source: { page: 0 } } },
])("rejects unsafe delete selectors without deleting anything: %j", async selector => {
  const store = open();
  await insertVectors(store, { contents: [content("keep")], vectors: [[1, 2]] });
  await expect(store.delete(selector as never)).rejects.toBeInstanceOf(TessarRagError);
  expect((await store.list()).length).toBe(1);
});

it.each([
  { contents: [content("a")], vectors: [] },
  { contents: [content("a")], vectors: [[]] },
  { contents: [content("a")], vectors: [[NaN, 1]] },
  { contents: [content("a")], vectors: [new Array(2)] },
  { contents: [{ ...content("a"), metadata: { x: undefined } }], vectors: [[1, 2]] },
  { contents: [{ ...content("a"), source: { page: 0 } }], vectors: [[1, 2]] },
  { contents: [{ ...content("a"), position: { contentIndex: 0, start: 3, end: 1 } }], vectors: [[1, 2]] },
])("rejects invalid inserts before writing: %j", async input => {
  const store = open();
  await expect(insertVectors(store, input as never)).rejects.toBeInstanceOf(TessarRagError);
  expect(await store.list()).toEqual([]);
});

it("rolls back a late SQLite insert failure and retains the native error", async () => {
  const filename = await file();
  const store = open({ filename });
  const db = new DatabaseSync(filename);
  try {
    db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON tessar_vectors
      WHEN json_extract(NEW.content, '$.text')='reject'
      BEGIN SELECT RAISE(ABORT, 'late write failure'); END`);
    const error = await insertVectors(store, { contents: [content("first"), content("reject")], vectors: [[1, 2], [3, 4]] })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "SQLITE_CONSTRAINT_TRIGGER", message: "late write failure" });
    expect(TessarRagError.isInstance(error)).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(await store.searchBM25("first reject")).toEqual([]);
    expect(await insertVectors(store, { contents: [content("after")], vectors: [[1, 2]] })).toHaveLength(1);
  } finally { db.close(); }
});

it("validates configuration, pagination and closed handles", async () => {
  for (const configuration of [{ embedding: null }, { embedding: {} }, { collection: " " }, { database: null }, { unexpected: true }])
    expect(() => open(configuration)).toThrow(TessarRagError);
  const store = open();
  for (const query of [{ limit: 0 }, { limit: 1001 }, { limit: null }, { limit: "1" }, { offset: -1 }, { offset: 0.5 }, { offset: null }, { order: "desc" }])
    await expect(store.list(query as never)).rejects.toBeInstanceOf(TessarRagError);
  expect(await insertVectors(store, { contents: [], vectors: [] })).toEqual([]);
  await store.close();
  await store.close();
  await expect(store.list()).rejects.toMatchObject({ code: "InvalidState" });
});

it("preserves caller data independently and coexists with agent state in the same file", async () => {
  const filename = await file();
  const backend = await sqlite.createLibsqlBackend({ database: createTestDatabase(filename)});
  try {
    const store = open({ filename });
    const original = { ...content("original"), metadata: { nested: { n: 1 } } };
    const vectors = [[1, 2]];
    const pending = insertVectors(store, { contents: [original], vectors });
    original.metadata.nested.n = 2;
    const [id] = await pending;
    vectors[0]![0] = 99;
    const saved = await store.get(id!);
    expect(saved?.content.metadata).toEqual({ nested: { n: 1 } });
    expect(saved?.vector).toEqual([1, 2]);
    const record = await backend.records.append({ namespace: "test", data: { ok: true } });
    await store.delete({ ids: [id!] });
    expect(await backend.records.get("test", record.id)).toEqual(record);
  } finally { await backend.close(); }
});

it("keeps native SQLite errors for unavailable database paths", async () => {
  const filename = await file();
  let error: unknown;
  try { open({ filename: join(filename, "missing", "db.sqlite") }); }
  catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/open|connection/i);
  expect(TessarRagError.isInstance(error)).toBe(false);
});
