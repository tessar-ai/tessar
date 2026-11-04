import type { ModelRef } from "@tessar/core";

/** Shared shape for provider or application embedding implementations. */
export interface EmbeddingModel {
  readonly ref: Readonly<ModelRef>;
  /** Embed strings or each object's text, preserving input order. */
  embedDocuments(input: readonly (string | { text: string })[]): Promise<number[][]>;
  /** Return the vector for a single search query. */
  embedQuery(input: string): Promise<number[]>;
}
