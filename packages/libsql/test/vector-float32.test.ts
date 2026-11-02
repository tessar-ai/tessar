import { expect, it } from "vitest";
import Database from "libsql";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeSqliteTestDirectory } from "../../../tests/helpers/sqlite-cleanup.js";
import { createTestStore, insert, search } from "./embedding-fixture.js";

const content = { text: "hello", format: "text" as const, metadata: {} };

it.each([[1e-100, 0], [1e100, 1], [1e-30, 0], [1e20, 0], [1e10, 0], [1e-15, 0], [1e-11, 0], [1e-10, 0]])("rejects cosine-invalid float32 vectors %j before insertion", async (...vector) => {
  const store = createTestStore({ filename: ":memory:" });
  try {
    await expect(insert(store, { contents: [content], vectors: [vector] })).rejects.toMatchObject({ code: "InvalidData" });
    expect(await store.list()).toEqual([]);
    expect((await store.info()).dimensions).toBeNull();
    await insert(store, { contents: [content], vectors: [[1, 0]] });
    await expect(search(store, vector)).rejects.toMatchObject({ code: "InvalidData" });
    expect(await store.list()).toHaveLength(1);
  } finally { await store.close(); }
});

it("bounds ordinary cosine rounding before applying the threshold", async () => {
  const store = createTestStore({ filename: ":memory:" });
  try {
    await insert(store, { contents: [{ ...content, metadata: { tag: "match" } }], vectors: [[1e-9, 0]] });
    for (const options of [{}, { filter: { metadata: { tag: "match" } } }]) {
      expect((await search(store, [1e-9, 0], options))[0]!.score).toBe(1);
      const opposite = await search(store, [-1e-9, 0], { ...options, score_threshold: -1 });
      expect(opposite).toHaveLength(1);
      expect(opposite[0]!.score).toBe(-1);
    }
    expect((await store.list())[0]!.vector).toEqual([1e-9, 0]);
  } finally { await store.close(); }
});

it("rejects invalid cosine scores from a previously damaged index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tessar-vector-float32-"));
  const filename = join(directory, "vectors.db");
  const store = createTestStore({ filename });
  try {
    await insert(store, { contents: [{ ...content, metadata: { tag: "match" } }], vectors: [[1, 0]] });
    const table = "tessar_vector_data_" + createHash("sha256").update("default").digest("hex");
    const db = new Database(filename);
    try { db.exec(`UPDATE "${table}" SET embedding=vector32('[0,0]')`); }
    finally { db.close(); }
    // Match the record without relying on the damaged approximate index.
    await expect(search(store, [1, 0], { filter: { metadata: { tag: "match" } } })).rejects.toMatchObject({ code: "InvalidData" });
  } finally {
    await store.close();
    await removeSqliteTestDirectory(directory);
  }
});
