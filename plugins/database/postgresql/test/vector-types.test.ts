import type { Pool } from "pg";
import { expect, it } from "vitest";
import { PostgresqlVectorStore, type PostgresqlVectorStoreOptions } from "@tessar/postgresql/vector";
import type { Content, EmbeddingModel, TextSearchResult, VectorStore } from "@tessar/rag";
import * as storage from "../src/index.js";

it("exports the vector adapter separately from state storage", () => {
  expect(typeof PostgresqlVectorStore).toBe("function");
  expect("PostgresqlVectorStore" in storage).toBe(false);
  if (false) {
    const options: PostgresqlVectorStoreOptions = { pool: {} as Pool, embedding: {} as EmbeddingModel };
    const store = new PostgresqlVectorStore(options);
    const contract: VectorStore = store;
    const bm25: Promise<TextSearchResult[]> = store.searchBM25("manual", { topK: 5, filter: { metadata: { project: "handbook" } } });
    const native = store.searchNative("manual", { topK: 5, filter: { source: { page: 1 } } });
    const ids: Promise<string[]> = store.insert([{} as Content]);
    // @ts-expect-error native search does not accept cosine score thresholds
    store.searchNative("manual", { score_threshold: 0.5 });
    // @ts-expect-error query is a required positional argument
    store.searchBM25({ query: "manual" });
    // @ts-expect-error dimensions are inferred from embedding output
    new PostgresqlVectorStore({ ...options, dimensions: 2 });
    // @ts-expect-error the old ambiguous method was removed
    store.searchText("manual");
    void [contract, bm25, native, ids];
  }
});
