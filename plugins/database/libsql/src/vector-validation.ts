import { immutable, TessarError } from "@tessar/core";
import { TessarRagError, type Content, type Chunk } from "@tessar/rag";
import type { SQLInputValue } from "./database.js";

export function invalid(message: string, code = "InvalidData"): never {
  throw new TessarRagError(code, message);
}

export function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    invalid(label + " must be a plain object");
}

export function keys(value: object, allowed: readonly string[]): void {
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.includes(key)))
    invalid("Unexpected input field");
}

export function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) invalid(label + " must be a nonempty string");
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function snapshot<T>(value: T): T {
  try { return immutable(value) as T; }
  catch (error) {
    if (TessarError.isInstance(error) && error.constructor === TessarError)
      throw new TessarRagError(error.code, error.message, { cause: error, details: error.details });
    throw error;
  }
}

export function contentsInput(value: unknown): readonly (Content | Chunk)[] {
  if (!Array.isArray(value)) invalid("Contents must be an array");
  const contents = snapshot(value);
  for (const content of contents) {
    object(content, "content");
    keys(content, ["text", "format", "source", "metadata", "position"]);
    if (typeof content.text !== "string" || !["text", "markdown"].includes(content.format as string))
      invalid("Content requires text and format text/markdown");
    object(content.metadata, "content metadata");
    if (content.source !== undefined) source(content.source);
    if (content.position !== undefined) {
      object(content.position, "chunk position");
      keys(content.position, ["contentIndex", "start", "end"]);
      const { contentIndex, start, end } = content.position;
      if (!integer(contentIndex, 0) || !integer(start, 0) || !integer(end, 0)
        || end < start || end - start !== content.text.length)
        invalid("Chunk position requires nonnegative integers and offsets matching text length");
    }
  }
  return contents as readonly (Content | Chunk)[];
}

export function vectorsInput(value: unknown, count: number): number[][] {
  const vectors = snapshot(value);
  if (!Array.isArray(vectors) || vectors.length !== count)
    invalid("Embedding must return exactly one vector per content");
  const dimensions = Array.isArray(vectors[0]) ? vectors[0].length : 0;
  if (!dimensions) invalid("Embedding vectors must not be empty");
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== dimensions
      || !Array.from(vector).every(number => typeof number === "number" && Number.isFinite(number))
      || !vector.some(number => number !== 0))
      invalid("Embedding vectors must have equal dimensions, finite numbers and nonzero direction");
    let squaredNorm = 0;
    for (const number of vector) {
      const value = Math.fround(number);
      squaredNorm = Math.fround(squaredNorm + Math.fround(value * value));
    }
    // Native cosine multiplies squared norms in float32 before taking the root.
    const normProduct = Math.fround(squaredNorm * squaredNorm);
    if (!Number.isFinite(normProduct) || normProduct < 2 ** -126)
      invalid("Embedding vector magnitude is outside the safe float32 cosine range");
  }
  return vectors;
}

function source(value: unknown): asserts value is { uri?: string; page?: number } {
  object(value, "source");
  keys(value, ["uri", "page"]);
  if (value.uri !== undefined && typeof value.uri !== "string") invalid("Source URI must be a string");
  if (value.page !== undefined && !integer(value.page, 1)) invalid("Source page must be a positive integer");
}

export function predicate(value: unknown): { sql: string; values: SQLInputValue[] } {
  object(value, "filter");
  keys(value, ["source", "metadata"]);
  const filter = snapshot(value);
  const conditions: string[] = [];
  const values: SQLInputValue[] = [];
  if (filter.source !== undefined) {
    source(filter.source);
    if (filter.source.uri !== undefined) {
      conditions.push("json_extract(content,'$.source.uri')=?");
      values.push(filter.source.uri);
    }
    if (filter.source.page !== undefined) {
      conditions.push("json_extract(content,'$.source.page')=?");
      values.push(filter.source.page);
    }
    if (!Object.keys(filter.source).length) invalid("Source filter must not be empty");
  }
  if (filter.metadata !== undefined) {
    object(filter.metadata, "metadata filter");
    if (!Object.keys(filter.metadata).length) invalid("Metadata filter must not be empty");
    for (const [key, expected] of Object.entries(filter.metadata)) {
      if (expected !== null && !["string", "number", "boolean"].includes(typeof expected))
        invalid("Metadata filters require scalar JSON values");
      const type = expected === null ? "null"
        : typeof expected === "boolean" ? String(expected)
          : typeof expected === "string" ? "text" : "number";
      conditions.push(`EXISTS (SELECT 1 FROM json_each(content,'$.metadata') AS m
        WHERE m.key=? AND ${type === "number" ? "m.type IN ('integer','real')" : "m.type=?"} AND m.value IS ?)`);
      values.push(key);
      if (type !== "number") values.push(type);
      values.push(typeof expected === "boolean" ? Number(expected) : expected as SQLInputValue);
    }
  }
  if (!conditions.length) invalid("Filter must contain at least one condition");
  return { sql: conditions.join(" AND "), values };
}
