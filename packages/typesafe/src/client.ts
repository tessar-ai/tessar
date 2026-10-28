import {
  assertJson,
  errorInfo,
  fail,
  immutable,
  normalizeScope,
  requireId,
  type JsonObject,
  type RecordStore,
} from "@tessar/core";
import { prepareRequest, validateResponse } from "./validation.js";
import { sendRequest } from "./transport.js";
import type {
  Questions,
  TypeSafeGenerateOptions,
  TypeSafeOptions,
  TypeSafeRequest,
  TypeSafeResponse,
} from "./types.js";

export class TypeSafe {
  readonly #url: string;
  readonly #headers: Headers;
  readonly #model?: string;
  readonly #timeout: number;
  readonly #maxRetries: number;
  readonly #records?: RecordStore;

  constructor(options: TypeSafeOptions = {}) {
    if ("state" in options || "questions" in options)
      fail(
        "InvalidConfiguration",
        "Pass state and questions to generate, not the constructor",
      );
    const apiKey = requireId(
      options.apiKey ?? process.env.TYPESAFE_API_KEY!,
      "TypeSafe API key",
    );
    const baseURL =
      options.baseURL ??
      process.env.TYPESAFE_BASE_URL ??
      "https://api.typesafe.ai";
    let url: URL;
    try {
      url = new URL(baseURL);
    } catch {
      fail("InvalidConfiguration", "Invalid TypeSafe baseURL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      fail(
        "InvalidConfiguration",
        "TypeSafe baseURL must be an HTTP(S) service URL",
      );
    this.#url = url.href.replace(/\/+$/, "") + "/v1/systemone";
    this.#headers = new Headers(options.headers);
    this.#headers.set("authorization", `Bearer ${apiKey}`);
    this.#headers.set("content-type", "application/json");
    this.#model = options.model;
    if (this.#model !== undefined) requireId(this.#model, "TypeSafe model");
    this.#timeout = options.timeout ?? 30_000;
    this.#maxRetries = options.maxRetries ?? 3;
    if (
      !Number.isSafeInteger(this.#timeout) ||
      this.#timeout < 1 ||
      this.#timeout > 2_147_483_647
    )
      fail(
        "InvalidConfiguration",
        "timeout must be a positive timer duration in milliseconds",
      );
    if (!Number.isSafeInteger(this.#maxRetries) || this.#maxRetries < 0)
      fail("InvalidConfiguration", "maxRetries must be a nonnegative integer");
    this.#records = options.records;
  }

  async generate<const Q extends Questions>(
    input: TypeSafeRequest<Q>,
    options: TypeSafeGenerateOptions = {},
  ): Promise<TypeSafeResponse<Q>> {
    const request = prepareRequest(input, this.#model);
    const id = requireId(options.id ?? crypto.randomUUID(), "TypeSafe call id");
    const scope = normalizeScope(options.scope);
    let metadata: JsonObject | undefined;
    if (options.metadata !== undefined) {
      if (
        !options.metadata ||
        typeof options.metadata !== "object" ||
        Array.isArray(options.metadata)
      )
        fail("InvalidConfiguration", "metadata must be a JSON object");
      metadata = immutable(options.metadata);
    }
    const startedAt = new Date().toISOString(),
      call = { attemptCount: 0 };
    let response: TypeSafeResponse<Q> | undefined;
    let failure: unknown;
    let failed = false;
    try {
      const result = await sendRequest(
        {
          url: this.#url,
          headers: this.#headers,
          body: JSON.stringify(request),
          timeout: this.#timeout,
          maxRetries: this.#maxRetries,
          signal: options.signal,
        },
        call,
      );
      validateResponse(result.value, request.questions, result.raw);
      response = immutable(result.value);
    } catch (error) {
      failed = true;
      failure = error;
    }
    if (this.#records) {
      const data = {
        request,
        response: response ?? null,
        status: failed
          ? options.signal?.aborted
            ? "cancelled"
            : "failed"
          : "completed",
        error: failed
          ? errorInfo(
              failure,
              options.signal?.aborted
                ? { source: "application" }
                : {
                    source: "provider",
                    providerId: "typesafe",
                    modelId: request.model,
                  },
            )
          : null,
        startedAt,
        endedAt: new Date().toISOString(),
        attemptCount: call.attemptCount,
        ...(metadata !== undefined ? { metadata } : {}),
      };
      try {
        assertJson(data);
        await this.#records.append({
          id,
          namespace: "typesafe.calls",
          scope,
          data,
        });
      } catch (storageError) {
        if (failed)
          throw new AggregateError(
            [failure, storageError],
            "TypeSafe call and record persistence both failed",
          );
        throw storageError;
      }
    }
    if (failed) throw failure;
    return response!;
  }
}
