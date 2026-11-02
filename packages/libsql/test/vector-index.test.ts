import { createTestStore, insert as insertVectors, search as searchVector } from "./embedding-fixture.js";
import Database from "libsql";
import { DatabaseSync as NativeDatabase } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createLibsqlBackend } from "../src/index.js";
import { removeSqliteTestDirectory } from "../../../tests/helpers/sqlite-cleanup.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tessar-vector-index-"));
  onTestFinished(() => removeSqliteTestDirectory(directory));
  return join(directory, "data.db");
}
const content = (text: string) => ({ text, format: "text" as const, metadata: {} });
function indexes(db: Database.Database) {
  return db.prepare("SELECT name,tbl_name FROM sqlite_master WHERE type='index' AND sql LIKE '%libsql_vector_idx%'")
    .all() as { name: string; tbl_name: string }[];
}
function search(db: Database.Database, index: { name: string; tbl_name: string }, vector: number[]) {
  return db.prepare(`SELECT r.id FROM vector_top_k(?,vector32(?),10) k
    JOIN "${index.tbl_name}" i ON i.rowid=k.id JOIN tessar_vectors r ON r.sequence=i.record_sequence`)
    .all(index.name, JSON.stringify(vector)).map(row => (row as { id: string }).id);
}

it("maintains isolated native indexes, committed deletion and reopen across connections", async () => {
  const filename = await fixture();
  const a = createTestStore({ filename, collection: "a';--", dimensions: 2 });
  const b = createTestStore({ filename, collection: "b", dimensions: 3 });
  const inspect = new Database(filename);
  try {
    const [idA] = await insertVectors(a, { contents: [{ ...content("a"), metadata: { group: "a" } }], vectors: [[1, 2]] });
    const [idB] = await insertVectors(b, { contents: [content("b")], vectors: [[1, 2, 3]] });
    const rows = indexes(inspect);
    expect(rows).toHaveLength(2);
    const indexA = rows.find(row => searchForDimension(inspect, row, [1, 2]).includes(idA!))!;
    const indexB = rows.find(row => searchForDimension(inspect, row, [1, 2, 3]).includes(idB!))!;
    expect(indexA).toBeDefined();
    expect(indexB).toBeDefined();
    expect(search(inspect, indexA, [1, 2])).toEqual([idA]);
    await a.delete({ filter: { metadata: { group: "a" } } });
    expect(search(inspect, indexA, [1, 2])).toEqual([]);
    expect(search(inspect, indexB, [1, 2, 3])).toEqual([idB]);
    await a.close();
    const reopened = createTestStore({ filename, collection: "a';--", dimensions: 2 });
    try { expect(await reopened.list()).toEqual([]); } finally { await reopened.close(); }
    await b.delete({ ids: [idB!] });
    expect(search(inspect, indexB, [1, 2, 3])).toEqual([]);
  } finally { inspect.close(); await a.close(); await b.close(); }
});

function searchForDimension(db: Database.Database, index: { name: string; tbl_name: string }, vector: number[]) {
  try { return search(db, index, vector); }
  catch (error) {
    if (/dimension/i.test((error as Error).message)) return [];
    throw error;
  }
}

it("rolls back main records when a native index write fails late", async () => {
  const filename = await fixture();
  const store = createTestStore({ filename, dimensions: 2 });
  const inspect = new Database(filename);
  try {
    const seed = await store.insert([content("seed")]);
    await store.delete({ ids: seed });
    const [index] = indexes(inspect);
    expect(index).toBeDefined();
    inspect.exec(`CREATE TRIGGER fail_index BEFORE INSERT ON "${index!.tbl_name}"
      WHEN NEW.record_sequence>2 BEGIN SELECT RAISE(ABORT,'index failure'); END`);
    await expect(insertVectors(store, { contents: [content("one"), content("two")], vectors: [[1, 2], [3, 4]] }))
      .rejects.toThrow("index failure");
    expect(await store.list()).toEqual([]);
    expect(search(inspect, index!, [1, 2])).toEqual([]);
    expect(await store.searchText("one two")).toEqual([]);
  } finally { inspect.close(); await store.close(); }
});

it("builds a missing index over existing JSON records without changing their values", async () => {
  const filename = await fixture();
  const native = new NativeDatabase(filename);
  native.exec(`CREATE TABLE tessar_vector_collections(name TEXT PRIMARY KEY,dimensions INTEGER NOT NULL);
    CREATE TABLE tessar_vector_models(name TEXT PRIMARY KEY,model TEXT NOT NULL);
    INSERT INTO tessar_vector_models VALUES('default','{"providerId":"fixture","modelId":"model"}');
    INSERT INTO tessar_vector_collections VALUES('default',2);
    CREATE TABLE tessar_vectors(sequence INTEGER PRIMARY KEY AUTOINCREMENT,collection TEXT NOT NULL,
      id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,content TEXT NOT NULL,vector TEXT NOT NULL);`);
  native.prepare("INSERT INTO tessar_vectors(collection,id,created_at,content,vector) VALUES('default','old','2026-10-30T00:00:00.000Z',?,?)")
    .run(JSON.stringify(content("old")), "[0.123456789012345,2]");
  native.close();
  const store = createTestStore({ filename, dimensions: 2 });
  const inspect = new Database(filename);
  try {
    expect(await store.get("old")).toMatchObject({ id: "old", createdAt: "2026-10-30T00:00:00.000Z", vector: [0.123456789012345, 2] });
    expect(indexes(inspect)).toHaveLength(1);
    expect(search(inspect, indexes(inspect)[0]!, [1, 2])).toEqual(["old"]);
    expect((await store.searchText("old")).map(r => r.id)).toEqual(["old"]);
  } finally { inspect.close(); await store.close(); }
});

it("rolls back native index deletion if deleting the stored record fails", async () => {
  const filename = await fixture();
  const store = createTestStore({ filename, dimensions: 2 });
  const inspect = new Database(filename);
  try {
    const [id] = await insertVectors(store, { contents: [{ ...content("keep"), metadata: { group: "keep" } }], vectors: [[1, 2]] });
    const index = indexes(inspect)[0]!;
    inspect.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON tessar_vectors BEGIN SELECT RAISE(ABORT,'delete failure'); END");
    for (const selector of [{ ids: [id!] }, { filter: { metadata: { group: "keep" } } }]) {
      await expect(store.delete(selector)).rejects.toThrow("delete failure");
      expect(await store.get(id!)).not.toBeNull();
      expect(search(inspect, index, [1, 2])).toEqual([id]);
      expect((await store.searchText("keep")).map(r => r.id)).toEqual([id]);
    }
  } finally { inspect.close(); await store.close(); }
});

it("retains an existing node:sqlite state file when reopening with the new engine", async () => {
  const filename = await fixture();
  const native = new NativeDatabase(filename);
  native.exec(`CREATE TABLE tessar_records(namespace TEXT NOT NULL,id TEXT NOT NULL,created_at TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(namespace,id));`);
  const record = { namespace: "old", id: "kept", createdAt: "2026-10-30T00:00:00.000Z", scope: {}, data: { value: 1 } };
  native.prepare("INSERT INTO tessar_records VALUES(?,?,?,?)").run(record.namespace, record.id, record.createdAt, JSON.stringify(record));
  native.close();
  const backend = await createLibsqlBackend({ filename });
  try { expect(await backend.records.get("old", "kept")).toEqual(record); }
  finally { await backend.close(); }
});
