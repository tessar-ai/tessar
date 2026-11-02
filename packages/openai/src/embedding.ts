import { Buffer } from "node:buffer";
import type OpenAI from "openai";
import type { ClientOptions } from "openai";
import type { EmbeddingCreateParams } from "openai/resources/embeddings";
import { fail, requireId, snapshotModelOptions, TessarError, type JsonObject, type ModelRef } from "@tessar/core";
import { clientKeys, createClient } from "./adapter.js";

export type OpenAIEmbeddingOptions = ClientOptions & Omit<EmbeddingCreateParams, "input"> & {
  documentOptions?: JsonObject;
  queryOptions?: JsonObject;
  batchSize?: number;
  concurrency?: number;
};
type RequestBody = Omit<EmbeddingCreateParams, "input">;

export class OpenAIEmbedding {
  readonly ref: Readonly<ModelRef>;
  readonly #client: OpenAI;
  readonly #body: Readonly<RequestBody>;
  readonly #documentOptions: JsonObject;
  readonly #queryOptions: JsonObject;
  readonly #batchSize?: number;
  readonly #concurrency: number;

  constructor(configuration: OpenAIEmbeddingOptions) {
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration))
      fail("InvalidConfiguration", "Embedding configuration must be an object");
    requireId(configuration.model, "embedding model");
    for (const key of ["batchSize", "concurrency"] as const) {
      const value = configuration[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
        fail("InvalidConfiguration", key + " must be a positive safe integer");
    }
    this.#batchSize = configuration.batchSize;
    this.#concurrency = configuration.concurrency ?? 1;
    this.#documentOptions = methodOptions(configuration.documentOptions);
    this.#queryOptions = methodOptions(configuration.queryOptions);
    this.ref = Object.freeze({ providerId: "openai", modelId: configuration.model });
    const clientOptions = Object.fromEntries(
      clientKeys.filter(key => configuration[key] !== undefined)
        .map(key => [key, configuration[key]]),
    ) as ClientOptions;
    const body = Object.fromEntries(Object.entries(configuration).filter(
      ([key, value]) => !clientKeys.includes(key as typeof clientKeys[number])
        && !["documentOptions", "queryOptions", "batchSize", "concurrency"].includes(key) && value !== undefined,
    ));
    if ("input" in body)
      fail("UnsupportedOption", "Embedding input belongs to embedDocuments() or embedQuery()");
    this.#body = snapshotModelOptions(body) as unknown as Readonly<RequestBody>;
    this.#client = createClient(clientOptions);
  }

  async embedDocuments(input: readonly (string | { text: string })[]): Promise<number[][]> {
    if (!Array.isArray(input)) fail("InvalidData", "Embedding documents must be an array");
    const texts = Array.from(input, document => {
      const text = typeof document === "string" ? document
        : document && typeof document === "object" ? document.text : undefined;
      if (typeof text !== "string")
        fail("InvalidData", "Embedding documents must be strings or objects with string text");
      return text;
    });
    if (!texts.length) return [];
    const batchSize = this.#batchSize ?? texts.length;
    if (texts.length <= batchSize) return this.#embed(texts, this.#documentOptions);
    const vectors: number[][] = new Array(texts.length);
    let next = 0;
    let dimensions: number | undefined;
    let failure: { error: unknown } | undefined;
    const worker = async () => {
      while (!failure && next < texts.length) {
        const start = next;
        next += batchSize;
        try {
          const batch = await this.#embed(texts.slice(start, start + batchSize), this.#documentOptions);
          if (dimensions !== undefined && batch[0]!.length !== dimensions)
            invalidResponse("Inconsistent embedding dimensions across batches");
          dimensions = batch[0]!.length;
          batch.forEach((vector, index) => { vectors[start + index] = vector; });
        } catch (error) {
          failure ??= { error };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#concurrency, Math.ceil(texts.length / batchSize)) }, worker));
    if (failure) throw failure.error;
    return vectors;
  }

  async embedQuery(input: string): Promise<number[]> {
    if (typeof input !== "string") fail("InvalidData", "Embedding query must be a string");
    return (await this.#embed(input, this.#queryOptions))[0]!;
  }

  async #embed(input: string | string[], options: JsonObject): Promise<number[][]> {
    const response = await this.#client.embeddings.create({ ...this.#body, ...options, input });
    const count = typeof input === "string" ? 1 : input.length;
    if (!response || !Array.isArray(response.data) || response.data.length !== count)
      invalidResponse("Expected one embedding per input");
    const vectors: (number[] | undefined)[] = new Array(count);
    let dimensions: number | undefined;
    for (const item of response.data) {
      const index = item?.index;
      if (!Number.isSafeInteger(index) || index < 0 || index >= count || vectors[index] !== undefined)
        invalidResponse("Embedding indices must be unique integers within the input range");
      const vector = decodeVector(item.embedding);
      if (dimensions !== undefined && vector.length !== dimensions)
        invalidResponse("Inconsistent embedding dimensions");
      dimensions = vector.length;
      vectors[index] = vector;
    }
    return vectors as number[][];
  }
}

function methodOptions(value: JsonObject | undefined): JsonObject {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("InvalidConfiguration", "Embedding method options must be a JSON object");
  for (const key of ["model", "input", "documentOptions", "queryOptions", "batchSize", "concurrency", ...clientKeys])
    if (key in value) fail("UnsupportedOption", key + " is not an embedding method option");
  return snapshotModelOptions(value);
}

function invalidResponse(message: string): never {
  throw new TessarError("InvalidData", message, { source: "provider" });
}

function decodeVector(value: unknown): number[] {
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length % 4 !== 0
      || bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, ""))
      invalidResponse("Invalid base64 embedding");
    value = Array.from({ length: bytes.length / 4 }, (_, index) => bytes.readFloatLE(index * 4));
  }
  if (!Array.isArray(value) || !value.length || !value.every(number => typeof number === "number" && Number.isFinite(number)))
    invalidResponse("Embedding must be a nonempty finite numeric vector");
  return value;
}
