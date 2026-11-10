import type { Db } from "mongodb";
import { expect, it } from "vitest";
import { MongoDBVectorStore, type MongoDBVectorStoreOptions } from "@tessar/mongodb/vector";
import type { Content, EmbeddingModel, TextSearchResult, VectorStore } from "@tessar/rag";
import * as storage from "../src/index.js";

it("exports MongoDB vector storage separately from state storage", () => {
  expect(typeof MongoDBVectorStore).toBe("function");
  expect("MongoDBVectorStore" in storage).toBe(false);
  if (false) {
    const options: MongoDBVectorStoreOptions = { database: {} as Db, embedding: {} as EmbeddingModel };
    const store = new MongoDBVectorStore(options);
    const contract: VectorStore = store;
    const ids: Promise<string[]> = store.insert([{} as Content]);
    const results: Promise<TextSearchResult[]> = store.searchBM25("manual", { topK: 5, filter: { metadata: { project: "handbook" } } });
    const native = store.searchNative("manual", { filter: { source: { page: 1 } } });
    // @ts-expect-error dimensions come from embedding output
    new MongoDBVectorStore({ ...options, dimensions: 2 });
    // @ts-expect-error index details belong to the adapter
    new MongoDBVectorStore({ ...options, filterFields: ["metadata.project"] });
    // @ts-expect-error no cosine threshold for native relevance
    store.searchNative("manual", { score_threshold: 0.5 });
    // @ts-expect-error query is required and positional
    store.searchBM25({ query: "manual" });
    // @ts-expect-error vector search embeds the question internally
    store.search([1, 0]);
    void [contract, ids, results, native];
  }
});
