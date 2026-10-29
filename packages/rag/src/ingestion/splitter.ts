import { immutable } from "@tessar/core";
import { asRagError, TessarRagError } from "../errors.js";
import { characterMeasure, chunkSpans } from "./chunking.js";
import type { Chunk, Content, SplitOptions, SplitStrategy } from "./types.js";
import { keys, object } from "./validation.js";

export class DocumentSplitter {
  readonly #strategy: SplitStrategy;
  readonly #maxSize: number;
  readonly #overlap: number;
  readonly #count?: (text: string) => number;

  constructor(options: SplitOptions) {
    try {
      object(options, "split options");
      keys(options, ["strategy", "maxSize", "overlap", "unit", "tokenizer"]);
      if (
        !["character", "recursive", "sentence", "markdown"].includes(
          options.strategy,
        )
      )
        throw new TessarRagError(
          "InvalidConfiguration",
          "Unknown split strategy",
        );
      const overlap = options.overlap === undefined ? 0 : options.overlap;
      if (
        !Number.isSafeInteger(options.maxSize) ||
        options.maxSize <= 0 ||
        !Number.isSafeInteger(overlap) ||
        overlap < 0 ||
        overlap >= options.maxSize
      )
        throw new TessarRagError(
          "InvalidConfiguration",
          "Require positive integer maxSize and 0 <= overlap < maxSize",
        );
      const unit = options.unit === undefined ? "characters" : options.unit;
      if (unit !== "characters" && unit !== "tokens")
        throw new TessarRagError("InvalidConfiguration", "Unknown split unit");
      if (unit === "tokens" && typeof options.tokenizer?.count !== "function")
        throw new TessarRagError(
          "InvalidConfiguration",
          "Token units require tokenizer.count(text)",
        );
      this.#strategy = options.strategy;
      this.#maxSize = options.maxSize;
      this.#overlap = overlap;
      if (unit === "tokens")
        this.#count = options.tokenizer!.count.bind(options.tokenizer);
    } catch (error) {
      throw asRagError(error);
    }
  }

  chunk(input: Content | readonly Content[]): Chunk[] {
    const contents = Array.from(
      Array.isArray(input) ? input : [input],
      snapshot,
    );
    return contents.flatMap((content, contentIndex) => {
      const text = content.text;
      const measure = this.#count
        ? (start: number, end: number) => {
            const count = this.#count!(text.slice(start, end));
            if (!Number.isSafeInteger(count) || count < 0)
              throw new TessarRagError(
                "InvalidData",
                "Tokenizer count must be a nonnegative safe integer",
              );
            return count;
          }
        : characterMeasure(text);
      return chunkSpans(
        text,
        this.#strategy,
        this.#maxSize,
        this.#overlap,
        measure,
      ).map(({ start, end }) => ({
        text: text.slice(start, end),
        format: content.format,
        ...(content.source === undefined
          ? {}
          : { source: structuredClone(content.source) }),
        metadata: structuredClone(content.metadata),
        position: { contentIndex, start, end },
      }));
    });
  }
}

function snapshot(value: unknown): Content {
  try {
    object(value, "Content");
    const content = immutable(value);
    if (
      typeof content.text !== "string" ||
      !["text", "markdown"].includes(content.format as string)
    )
      throw new TessarRagError(
        "InvalidData",
        "Content requires text and format text/markdown",
      );
    object(content.metadata, "Content metadata");
    if (content.source !== undefined) {
      object(content.source, "Content source");
      keys(content.source, ["uri", "page"]);
      if (
        content.source.uri !== undefined &&
        typeof content.source.uri !== "string"
      )
        throw new TessarRagError(
          "InvalidData",
          "Content source URI must be a string",
        );
      if (
        content.source.page !== undefined &&
        (!Number.isSafeInteger(content.source.page) ||
          (content.source.page as number) < 1)
      )
        throw new TessarRagError(
          "InvalidData",
          "Content source page must be a positive integer",
        );
    }
    return content as unknown as Content;
  } catch (error) {
    throw asRagError(error);
  }
}
