import { expect, it } from "vitest";
import { LibsqlVectorStore, type LibsqlVectorStoreOptions } from "@tessar/libsql/vector";
import * as storage from "../src/index.js";
import type { Chunk, Content, EmbeddingModel, TextSearchOptions, TextSearchResult, VectorCollectionInfo, VectorRecord, VectorSearchOptions, VectorSearchResult, VectorStore } from "@tessar/rag";

it("exposes independent vector storage with generated identity and dates", () => {
  expect(typeof LibsqlVectorStore).toBe("function");
  if (false) {
    const embedding = {} as EmbeddingModel;
    const config: LibsqlVectorStoreOptions = { filename: "vectors.db", embedding };
    // @ts-expect-error vector store belongs to the vector entry, not state storage
    storage.LibsqlVectorStore;
    void config;
    const store: VectorStore = new LibsqlVectorStore(config);
    const chunk = {} as Chunk;
    const content = {} as Content;
    const ids: Promise<string[]> = store.insert([chunk, content]);
    const info: Promise<VectorCollectionInfo> = store.info();
    // @ts-expect-error dimensions are inferred, not configured on the store
    new LibsqlVectorStore({ ...config, dimensions: 2 });
    const record: Promise<VectorRecord | null> = store.get("id");
    const list: Promise<VectorRecord[]> = store.list({ limit: 10, offset: 0, filter: { source: { page: 3 } } });
    const options: VectorSearchOptions = { topK: 5, score_threshold: 0.7, filter: { metadata: { project: "handbook" } } };
    const results: Promise<VectorSearchResult[]> = store.search("question", options);
    store.search("question");
    store.search("question", {});
    const textOptions: TextSearchOptions = { topK: 5, filter: { source: { page: 3 } } };
    const textResults: Promise<TextSearchResult[]> = store.searchText("manual", textOptions);
    store.searchText("manual");
    // @ts-expect-error text query must be a string
    store.searchText([1, 2]);
    // @ts-expect-error required query is positional
    store.searchText({ query: "manual" });
    // @ts-expect-error cosine threshold does not apply to BM25
    store.searchText("manual", { score_threshold: 0.7 });
    // @ts-expect-error text is not a metadata/source filter
    store.searchText("manual", { filter: { text: "manual" } });
    // @ts-expect-error search embeds text, not raw vector input
    store.search([1, 2]);
    // @ts-expect-error options must be an object
    store.search("question", 5);
    store.search("question", { filter: { metadata: { project: "handbook" } } });
    // @ts-expect-error text filtering is not supported
    store.search("question", { filter: { text: "manual" } });
    // @ts-expect-error score_threshold is numeric
    store.search("question", { score_threshold: "0.7" });
    // @ts-expect-error vector is required outside the options object
    store.search({ vector: [1, 2], topK: 5 });
    // @ts-expect-error vector is required
    store.search();
    store.delete({ ids: ["id"] });
    store.delete({ filter: { metadata: { active: true } } });
    // @ts-expect-error text is not a storage filter
    store.list({ filter: { text: "manual" } });
    // @ts-expect-error text is not a storage filter
    store.delete({ filter: { text: "manual" } });
    // @ts-expect-error IDs are generated internally
    store.insert({ contents: [chunk], vectors: [[1, 2]], ids: ["id"] });
    // @ts-expect-error insertion dates are generated internally
    store.insert({ contents: [chunk], vectors: [[1, 2]], createdAt: "date" });
    // @ts-expect-error no positional overload
    store.insert([chunk], [[1, 2]]);
    // @ts-expect-error exactly one delete selector
    store.delete({ ids: ["id"], filter: { metadata: { active: true } } });
    // @ts-expect-error delete requires a selector
    store.delete({});
    // @ts-expect-error metadata equality accepts JSON scalars only
    store.list({ filter: { metadata: { nested: {} } } });
    void ids;
    void record;
    void list;
    void results;
    void textResults;
    void info;
  }
});
