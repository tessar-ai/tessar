import { createTestDatabase } from "./database-fixture.js";
import { LibsqlVectorStore } from "@tessar/libsql/vector";
import type { Content, Chunk, EmbeddingModel, VectorSearchOptions } from "@tessar/rag";

class FixtureEmbedding implements EmbeddingModel {
  readonly ref = { providerId: "fixture", modelId: "model" };
  vectors?: number[][];
  query = [1, 0];
  constructor(readonly dimensions: number) {}
  async embedDocuments(input: readonly (string | { text: string })[]) {
    return this.vectors ?? input.map(() => Array.from({ length: this.dimensions }, () => 1));
  }
  async embedQuery() { return this.query; }
}

const models = new WeakMap<LibsqlVectorStore, FixtureEmbedding>();
export function createTestStore(options: { filename: string; collection?: string; dimensions?: number }) {
  const { dimensions = 2, filename, ...storage } = options;
  const embedding = new FixtureEmbedding(dimensions);
  const store = new LibsqlVectorStore({ database: createTestDatabase(filename), embedding, ...storage });
  models.set(store, embedding);
  return store;
}

export function insert(store: LibsqlVectorStore, input: { contents: readonly (Content | Chunk)[]; vectors: number[][] }) {
  models.get(store)!.vectors = input.vectors;
  return store.insert(input.contents);
}

export function search(store: LibsqlVectorStore, vector: number[], options?: VectorSearchOptions) {
  models.get(store)!.query = vector;
  return store.search("fixture question", options);
}
