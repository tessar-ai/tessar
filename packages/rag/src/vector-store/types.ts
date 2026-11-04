import type { Chunk, Content } from "../ingestion/types.js";
import type { ModelRef } from "@tessar/core";

export interface VectorCollectionInfo {
  collection: string;
  model: Readonly<ModelRef>;
  dimensions: number | null;
}

export interface VectorRecord {
  id: string;
  createdAt: string;
  content: Content | Chunk;
  vector: number[];
}

export interface VectorSearchOptions {
  /** Maximum candidates to return; defaults to 5. */
  topK?: number;
  /** Inclusive minimum cosine similarity, between -1 and 1; omitted means no threshold. */
  score_threshold?: number;
  filter?: VectorFilter;
}

export interface VectorSearchResult {
  id: string;
  createdAt: string;
  content: Content | Chunk;
  /** Cosine similarity (1 - cosine distance); larger is nearer. */
  score: number;
}

export interface TextSearchOptions {
  /** Maximum matches to return; defaults to 5. */
  topK?: number;
  filter?: VectorFilter;
}

export interface TextSearchResult {
  id: string;
  createdAt: string;
  content: Content | Chunk;
  /** BM25 relevance, larger is better; not normalized cosine similarity. */
  score: number;
}

export interface VectorFilter {
  source?: { uri?: string; page?: number };
  /** Exact matches on top-level metadata keys; all conditions must match. */
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface VectorListOptions {
  filter?: VectorFilter;
  limit?: number;
  offset?: number;
}

export type VectorDelete =
  | { ids: readonly string[]; filter?: never }
  | { filter: VectorFilter; ids?: never };

export interface VectorStore {
  insert(contents: readonly (Content | Chunk)[]): Promise<string[]>;
  info(): Promise<VectorCollectionInfo>;
  get(id: string): Promise<VectorRecord | null>;
  list(options?: VectorListOptions): Promise<VectorRecord[]>;
  search(query: string, options?: VectorSearchOptions): Promise<VectorSearchResult[]>;
  searchBM25(query: string, options?: TextSearchOptions): Promise<TextSearchResult[]>;
  delete(selector: VectorDelete): Promise<number>;
  close(): Promise<void>;
}
