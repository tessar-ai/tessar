import type { JsonObject } from "@tessar/core";

export type ReadSource =
  | { path: string; url?: never; text?: never; data?: never }
  | { url: string; path?: never; text?: never; data?: never }
  | { text: string; mimeType?: string; path?: never; url?: never; data?: never }
  | {
      data: Uint8Array;
      mimeType: string;
      path?: never;
      url?: never;
      text?: never;
    };

export interface ReadInput {
  id?: string;
  source: ReadSource;
}

export interface ReadOptions {
  metadata?: JsonObject;
}

export interface Content {
  text: string;
  format: "text" | "markdown";
  source?: { uri?: string; page?: number };
  metadata: JsonObject;
}

export interface ReadTask {
  readonly id: string;
  result(): Promise<Content[]>;
  cancel(reason?: string): void;
}

export type SplitStrategy = "character" | "recursive" | "sentence" | "markdown";

export interface Tokenizer {
  count(text: string): number;
}

export type SplitOptions = {
  strategy: SplitStrategy;
  maxSize: number;
  overlap?: number;
} & (
  | { unit?: "characters"; tokenizer?: Tokenizer }
  | { unit: "tokens"; tokenizer: Tokenizer }
);

export interface Chunk extends Content {
  /** UTF-16 offsets into the original Content; end is exclusive. */
  position: { contentIndex: number; start: number; end: number };
}
