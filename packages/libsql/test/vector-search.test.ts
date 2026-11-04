import { createTestStore, insert as insertVectors, search as searchVector } from "./embedding-fixture.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { TessarRagError, type Chunk } from "@tessar/rag";
import { removeSqliteTestDirectory } from "../../../tests/helpers/sqlite-cleanup.js";

const content = (text: string) => ({ text, format: "text" as const, metadata: {} });
function store() {
  const result = createTestStore({ filename: ":memory:", dimensions: 2 });
  onTestFinished(() => result.close());
  return result;
}

it("returns stored chunks with descending cosine similarity and no vector payload", async () => {
  const db = store();
  const chunk: Chunk = {
    text: "manual", format: "markdown", source: { uri: "file:///manual.pdf", page: 2 },
    metadata: { project: "handbook" }, position: { contentIndex: 1, start: 4, end: 10 },
  };
  const ids = await insertVectors(db, { contents: [content("opposite"), content("orthogonal"), chunk], vectors: [[-1, 0], [0, 1], [1, 0]] });
  const results = await searchVector(db, [1, 0], { topK: 3 });
  expect(results.map(result => result.id)).toEqual([ids[2], ids[1], ids[0]]);
  expect(results.map(result => result.score)).toEqual([1, 0, -1]);
  expect(results[0]).toEqual({ id: ids[2], createdAt: (await db.get(ids[2]!))!.createdAt, content: chunk, score: 1 });
  expect(await searchVector(db, [1, 0], { topK: 1 })).toEqual([results[0]]);
  // Magnitude does not change cosine ordering.
  expect(await searchVector(db, [2, 0], { topK: 3 })).toEqual(results);
});

it("defaults to five candidates and returns fewer for small or empty collections", async () => {
  const db = store();
  expect(await searchVector(db, [1, 0])).toEqual([]);
  const vectors = Array.from({ length: 7 }, (_, i) => [1, i / 10]);
  const ids = await insertVectors(db, { contents: vectors.map((_, i) => content(String(i))), vectors });
  expect((await searchVector(db, [1, 0])).map(result => result.id)).toEqual(ids.slice(0, 5));
  expect(await searchVector(db, [1, 0], {})).toHaveLength(5);
  expect(await searchVector(db, [1, 0], { topK: 20 })).toHaveLength(7);
});

it("isolates collections and reflects committed insertion/deletion after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tessar-vector-search-"));
  onTestFinished(() => removeSqliteTestDirectory(directory));
  const filename = join(directory, "vectors.db");
  const a = createTestStore({ filename, collection: "a';--", dimensions: 2 });
  const b = createTestStore({ filename, collection: "b", dimensions: 3 });
  try {
    const [id] = await insertVectors(a, { contents: [content("keep")], vectors: [[1, 0]] });
    await insertVectors(b, { contents: [content("other")], vectors: [[1, 0, 0]] });
    await a.close();
    const reopened = createTestStore({ filename, collection: "a';--", dimensions: 2 });
    try {
      expect((await searchVector(reopened, [1, 0])).map(result => result.id)).toEqual([id]);
      await reopened.delete({ ids: [id!] });
      expect(await searchVector(reopened, [1, 0])).toEqual([]);
      expect(await searchVector(b, [1, 0, 0])).toHaveLength(1);
    } finally { await reopened.close(); }
  } finally { await a.close(); await b.close(); }
});

it("rejects malformed search inputs and operations on a closed store", async () => {
  const db = store();
  await db.insert([{ text: "seed", format: "text", metadata: {} }]);
  for (const query of [null, undefined, {}, [], [1, 0], "", " \t"])
    await expect(db.search(query as never)).rejects.toMatchObject({ code: "InvalidData" });
  for (const vector of [undefined, null, {}, "text", [], [1], [NaN, 1], [Infinity, 1], [0, 0], { vector: [1, 0] }]) {
    await expect(searchVector(db, vector as never))
      .rejects.toMatchObject({ code: "InvalidData" });
  }
  for (const options of [null, 5, [], { filter: {} }, { filter: { text: "manual" } },
    { filter: { source: { page: 0 } } }, { filter: { metadata: { nested: {} } } },
    ...[NaN, Infinity, "0.5", null, -1.1, 1.1].map(score_threshold => ({ score_threshold })),
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "5", null].map(topK => ({ topK }))]) {
    await expect(searchVector(db, [1, 0], options as never))
      .rejects.toMatchObject({ code: "InvalidData" });
  }
  await db.close();
  await expect(searchVector(db, [1, 0])).rejects.toSatisfy(error =>
    TessarRagError.isInstance(error) && error.code === "InvalidState");
});

it("applies inclusive score thresholds, including zero and negative values", async () => {
  const db = store();
  await insertVectors(db, { contents: [content("same"), content("orthogonal"), content("opposite")], vectors: [[1, 0], [0, 1], [-1, 0]] });
  expect((await searchVector(db, [1, 0], { score_threshold: 1 })).map(r => r.score)).toEqual([1]);
  expect((await searchVector(db, [1, 0], { score_threshold: 0 })).map(r => r.score)).toEqual([1, 0]);
  expect((await searchVector(db, [1, 0], { score_threshold: -1 })).map(r => r.score)).toEqual([1, 0, -1]);
  expect(await searchVector(db, [0, -1], { score_threshold: 0.9 })).toEqual([]);
});

it("filters before selecting topK, combining source and typed metadata conditions", async () => {
  const db = store();
  const ids = await insertVectors(db, {
    contents: [
      { ...content("global nearest"), metadata: { project: "other" } },
      { ...content("wrong page"), source: { uri: "file:///manual.pdf", page: 2 }, metadata: { project: "handbook", active: true, revision: 1, 'a".$': null } },
      { ...content("match"), source: { uri: "file:///manual.pdf", page: 3 }, metadata: { project: "handbook", active: true, revision: 1, 'a".$': null } },
      { ...content("wrong type"), source: { uri: "file:///manual.pdf", page: 3 }, metadata: { project: "handbook", active: 1, revision: "1" } },
    ], vectors: [[1, 0], [1, 0.1], [1, 0.5], [1, 0.2]],
  });
  const filter = { source: { uri: "file:///manual.pdf", page: 3 }, metadata: { project: "handbook", active: true, revision: 1, 'a".$': null } };
  const results = await searchVector(db, [1, 0], { topK: 1, filter });
  expect(results.map(r => r.id)).toEqual([ids[2]]);
  expect(results[0]!.score).toBeCloseTo(1 / Math.sqrt(1.25), 5);
  expect(await searchVector(db, [1, 0], { filter, score_threshold: 0.95 })).toEqual([]);
  expect(await searchVector(db, [1, 0], { filter: { metadata: { missing: null } } })).toEqual([]);
  expect(await searchVector(db, [1, 0], { filter: { source: { uri: "' OR 1=1 --" } } })).toEqual([]);
});
