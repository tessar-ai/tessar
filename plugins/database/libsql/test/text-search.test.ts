import { createTestStore, insert as insertVectors, search as searchVector } from "./embedding-fixture.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { type Content, type Chunk, TessarRagError } from "@tessar/rag";
import { LibsqlVectorStore } from "@tessar/libsql/vector";
import { removeSqliteTestDirectory } from "../../../../tests/helpers/sqlite-cleanup.js";

const content = (text: string): Content => ({ text, format: "text", metadata: {} });
function open(filename = ":memory:", collection = "default") {
  const store = createTestStore({ filename, collection, dimensions: 2 });
  onTestFinished(() => store.close());
  return store;
}
function insert(store: LibsqlVectorStore, contents: readonly Content[]) {
  return insertVectors(store, { contents, vectors: contents.map(() => [1, 0]) });
}

it("ranks by native BM25 and preserves chunk provenance without vector payload", async () => {
  const store = open();
  const chunk: Chunk = {
    text: "tessar tessar", format: "markdown",
    source: { uri: "file:///manual.pdf", page: 2 }, metadata: { project: "handbook" },
    position: { contentIndex: 0, start: 0, end: 13 }
  };
  const ids = await insert(store, [content("tessar configuration in a longer document"), chunk, content("unrelated")]);
  const results = await store.searchBM25("tessar");
  expect(results.map(r => r.id)).toEqual([ids[1], ids[0]]);
  expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  expect(results[1]!.score).toBeGreaterThan(0);
  expect(results[0]).toEqual({
    id: ids[1], createdAt: (await store.get(ids[1]!))!.createdAt,
    content: chunk, score: results[0]!.score
  });
  expect(await store.searchBM25("tessar", { topK: 1 })).toEqual([results[0]]);
});

it("defaults to five matches and returns [] for empty, missing or tokenless queries", async () => {
  const store = open();
  expect(await store.searchBM25("manual")).toEqual([]);
  await insert(store, Array.from({ length: 7 }, () => content("manual")));
  expect(await store.searchBM25("manual")).toHaveLength(5);
  expect(await store.searchBM25("manual", {})).toHaveLength(5);
  expect(await store.searchBM25("manual", { topK: 20 })).toHaveLength(7);
  expect(await store.searchBM25("missing")).toEqual([]);
  expect(await store.searchBM25("* : \" ()")).toEqual([]);
});

it("accepts ordinary text with OR matching and escapes FTS syntax and quotes", async () => {
  const store = open();
  const ids = await insert(store, [content("alpha"), content("beta"), content("cấu hình Tessar"), content("unrelated")]);
  expect(new Set((await store.searchBM25("alpha beta")).map(r => r.id))).toEqual(new Set(ids.slice(0, 2)));
  expect(new Set((await store.searchBM25("alpha NOT beta")).map(r => r.id))).toEqual(new Set(ids.slice(0, 2)));
  expect((await store.searchBM25('"alpha"')).map(r => r.id)).toEqual([ids[0]]);
  expect(await store.searchBM25("text:alpha")).toEqual([]);
  expect((await store.searchBM25("TESSAR")).map(r => r.id)).toEqual([ids[2]]);
});

it("filters source and typed metadata before topK, using bound literals", async () => {
  const store = open();
  const ids = await insert(store, [
    { ...content("manual manual"), metadata: { project: "other" } },
    { ...content("manual"), source: { uri: "file:///manual.pdf", page: 3 }, metadata: { active: true, n: 1, 'a".$': null } },
    { ...content("manual"), source: { uri: "file:///manual.pdf", page: 3 }, metadata: { active: 1, n: "1" } },
    content("unrelated"),
  ]);
  const results = await store.searchBM25("manual", {
    topK: 1,
    filter: { source: { uri: "file:///manual.pdf", page: 3 }, metadata: { active: true, n: 1, 'a".$': null } }
  });
  expect(results.map(r => r.id)).toEqual([ids[1]]);
  expect(await store.searchBM25("manual", { filter: { metadata: { missing: null } } })).toEqual([]);
  expect(await store.searchBM25("manual", { filter: { source: { uri: "' OR 1=1 --" } } })).toEqual([]);
});

it("isolates collection matches and BM25 statistics, persists and mirrors both delete selectors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tessar-bm25-"));
  onTestFinished(() => removeSqliteTestDirectory(directory));
  const filename = join(directory, "vectors.db");
  const a = open(filename, "a';--"), b = open(filename, "b");
  const [idB] = await insert(b, [content("shared keyword"), content("unrelated")]);
  const before = await b.searchBM25("shared");
  const ids = await insert(a, [
    { ...content("shared"), metadata: { group: "remove" } },
    ...Array.from({ length: 8 }, () => content("shared shared")),
  ]);
  expect(await b.searchBM25("shared")).toEqual(before);
  expect(before.map(r => r.id)).toEqual([idB]);
  await a.close();
  const reopened = open(filename, "a';--");
  expect(await reopened.searchBM25("shared", { topK: 20 })).toHaveLength(9);
  expect(await reopened.delete({ filter: { metadata: { group: "remove" } } })).toBe(1);
  expect((await reopened.searchBM25("shared", { topK: 20 })).map(r => r.id)).not.toContain(ids[0]);
  await reopened.delete({ ids: ids.slice(1) });
  expect(await reopened.searchBM25("shared")).toEqual([]);
  expect(await b.searchBM25("shared")).toEqual(before);
});

it("rejects invalid queries/options and closed handles", async () => {
  const store = open();
  for (const query of [null, undefined, 1, {}, [], "", " \t\n", "alpha\u0000"])
    await expect(store.searchBM25(query as never)).rejects.toMatchObject({ code: "InvalidData" });
  for (const options of [null, [], 5, { score_threshold: 0.7 }, { filter: {} }, { filter: { text: "manual" } },
    { filter: { metadata: { nested: {} } } }, { filter: { source: { page: 0 } } },
    ...[0, -1, 1.5, NaN, Infinity, "5", null, Number.MAX_SAFE_INTEGER + 1].map(topK => ({ topK }))])
    await expect(store.searchBM25("manual", options as never)).rejects.toMatchObject({ code: "InvalidData" });
  await store.close();
  await expect(store.searchBM25("manual")).rejects.toSatisfy(error =>
    TessarRagError.isInstance(error) && error.code === "InvalidState");
});
