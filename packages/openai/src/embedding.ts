import { Buffer } from "node:buffer";
import type OpenAI from "openai";
import type { ClientOptions } from "openai";
import type { EmbeddingCreateParams } from "openai/resources/embeddings";
import { fail, requireId, snapshotModelOptions, TessarError } from "@tessar/core";
import { clientKeys, createClient } from "./adapter.js";

export type OpenAIEmbeddingOptions = ClientOptions & Omit<EmbeddingCreateParams, "input">;
type RequestBody = Omit<EmbeddingCreateParams, "input">;

export class OpenAIEmbedding {
  readonly #client: OpenAI;
  readonly #body: Readonly<RequestBody>;

  constructor(configuration: OpenAIEmbeddingOptions) {
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration))
      fail("InvalidConfiguration", "Embedding configuration must be an object");
    requireId(configuration.model, "embedding model");
    const clientOptions = Object.fromEntries(
      clientKeys.filter(key => configuration[key] !== undefined)
        .map(key => [key, configuration[key]]),
    ) as ClientOptions;
    const body = Object.fromEntries(Object.entries(configuration).filter(
      ([key, value]) => !clientKeys.includes(key as typeof clientKeys[number]) && value !== undefined,
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
    return this.#embed(texts);
  }

  async embedQuery(input: string): Promise<number[]> {
    if (typeof input !== "string") fail("InvalidData", "Embedding query must be a string");
    return (await this.#embed(input))[0]!;
  }

  async #embed(input: string | string[]): Promise<number[][]> {
    const response = await this.#client.embeddings.create({ ...this.#body, input });
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
