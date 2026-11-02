import { TessarError } from "@tessar/core";

export interface OpenAIRerankerOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
}

export interface RerankOptions {
  topK?: number;
  score_threshold?: number;
}

export type RerankDocument = string | { text: string } | { content: { text: string } };
export interface RerankResult<T> {
  document: T;
  score: number;
}

export class OpenAIReranker {
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(configuration: OpenAIRerankerOptions) {
    if (!configuration || typeof configuration !== "object")
      throw new TessarError("InvalidConfiguration", "Reranker configuration must be an object");
    for (const key of ["endpoint", "apiKey", "model"] as const)
      if (typeof configuration[key] !== "string" || !configuration[key].trim())
        throw new TessarError("InvalidConfiguration", key + " must be a nonempty string");
    let url: URL;
    try { url = new URL(configuration.endpoint); }
    catch { throw new TessarError("InvalidConfiguration", "Reranker endpoint must be an HTTP URL"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      throw new TessarError("InvalidConfiguration", "Reranker endpoint must be an HTTP URL without credentials");
    if (configuration.fetch !== undefined && typeof configuration.fetch !== "function")
      throw new TessarError("InvalidConfiguration", "Reranker fetch must be a function");
    this.#endpoint = configuration.endpoint;
    this.#apiKey = configuration.apiKey;
    this.#model = configuration.model;
    this.#fetch = configuration.fetch ?? globalThis.fetch;
  }

  async rerank<T extends RerankDocument>(query: string, candidates: readonly T[], options: RerankOptions = {}): Promise<RerankResult<T>[]> {
    if (typeof query !== "string" || !Array.isArray(candidates))
      throw new TessarError("InvalidData", "Rerank requires a string query and an array of candidates");
    if (!options || typeof options !== "object" || Array.isArray(options))
      throw new TessarError("InvalidData", "Rerank options must be an object");
    const { topK = 5, score_threshold } = options;
    if (!Number.isSafeInteger(topK) || topK < 1)
      throw new TessarError("InvalidData", "topK must be a positive safe integer");
    if (score_threshold !== undefined && (typeof score_threshold !== "number" || !Number.isFinite(score_threshold)))
      throw new TessarError("InvalidData", "score_threshold must be finite");
    const documents = Array.from(candidates);
    const texts = documents.map(document => {
      const text = typeof document === "string" ? document
        : document && typeof document === "object"
          ? "text" in document ? document.text : document.content?.text : undefined;
      if (typeof text !== "string")
        throw new TessarError("InvalidData", "Rerank candidates must contain string text");
      return text;
    });
    if (!documents.length) return [];
    const limit = Math.min(topK, documents.length);
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + this.#apiKey },
      body: JSON.stringify({ model: this.#model, query, documents: texts, top_n: limit }),
    });
    if (!response.ok) {
      if (response.body && !response.body.locked)
        await response.body.cancel().catch(() => { });
      throw new TessarError("RerankFailed", "Rerank request failed with HTTP " + response.status, {
        source: "provider", details: { status: response.status },
      });
    }
    let body: unknown;
    try { body = await response.json(); }
    catch (error) {
      if (error instanceof SyntaxError) invalidResponse();
      throw error;
    }
    const results = body && typeof body === "object" && "results" in body ? body.results : undefined;
    if (!Array.isArray(results) || results.length > limit) invalidResponse();
    const seen = new Set<number>();
    return results.map((result: unknown): RerankResult<T> => {
      if (!result || typeof result !== "object" || !("index" in result) || !("relevance_score" in result)) invalidResponse();
      const { index, relevance_score: score } = result;
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= documents.length || seen.has(index)
        || typeof score !== "number" || !Number.isFinite(score)) invalidResponse();
      seen.add(index);
      return { document: documents[index]!, score };
    }).filter(result => score_threshold === undefined || result.score >= score_threshold)
      .sort((left, right) => right.score - left.score);
  }
}

function invalidResponse(): never {
  throw new TessarError("InvalidData", "Invalid rerank results", { source: "provider" });
}
