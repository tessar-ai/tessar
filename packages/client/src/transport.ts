import type { ErrorInfo } from "./wire.js";
import { CLIENT_ERROR_CODE, TessarClientError } from "./errors.js";

export interface TessarClientOptions {
  baseURL: string;
  headers?: HeadersInit;
  credentials?: RequestCredentials;
  fetch?: typeof globalThis.fetch;
}
export interface RequestOptions { signal?: AbortSignal }
export const HTTP_METHOD = { GET: "GET", POST: "POST", DELETE: "DELETE" } as const;
export const MIME = { JSON: "application/json", SSE: "text/event-stream" } as const;
export const HEADER = { ACCEPT: "accept", CONTENT_TYPE: "content-type" } as const;
const NO_CONTENT = 204;
const API_PATH = "/api";
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
interface TransportOptions extends RequestOptions {
  body?: unknown;
  query?: object;
}

export function resourceId(id: string): string {
  if (typeof id !== "string" || !id.trim() || id === "." || id === "..")
    throw new TessarClientError(CLIENT_ERROR_CODE.INVALID_CONFIGURATION, "Resource ID must be a nonempty URL segment");
  return id;
}

export class Transport {
  private readonly base: string;
  private readonly headers: Headers;
  constructor(private readonly options: TessarClientOptions) {
    let url: URL;
    try { url = new URL(options.baseURL); }
    catch (cause) { throw new TessarClientError(CLIENT_ERROR_CODE.INVALID_CONFIGURATION, "baseURL must be an HTTP(S) URL", { cause }); }
    if (!HTTP_PROTOCOLS.has(url.protocol) || url.href.includes("?") || url.href.includes("#") || url.username || url.password)
      throw new TessarClientError(CLIENT_ERROR_CODE.INVALID_CONFIGURATION, "baseURL must be HTTP(S) without credentials, query or fragment");
    this.base = url.href.replace(/\/+$/, "") + API_PATH;
    this.headers = new Headers(options.headers);
  }

  async response(method: string, segments: readonly string[], options: TransportOptions = {}, accept: string = MIME.JSON): Promise<Response> {
    const url = new URL(this.base + "/" + segments.map(segment => encodeURIComponent(resourceId(segment))).join("/"));
    for (const [key, value] of Object.entries(options.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    const headers = new Headers(this.headers);
    headers.set(HEADER.ACCEPT, accept);
    if (options.body !== undefined) headers.set(HEADER.CONTENT_TYPE, MIME.JSON);
    const response = await (this.options.fetch ?? globalThis.fetch)(url.href, {
      method, headers, credentials: this.options.credentials, signal: options.signal,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) {
      // Read the body outside the JSON catch so network/abort errors keep their identity.
      const text = await response.text();
      let remote: ErrorInfo | undefined;
      try {
        const value: unknown = JSON.parse(text);
        if (isObject(value) && isErrorInfo(value.error)) remote = value.error;
      } catch { /* A proxy may return HTML instead of a Tessar error. */ }
      throw new TessarClientError(CLIENT_ERROR_CODE.HTTP_ERROR, remote?.message ?? `HTTP request failed (${response.status})`, { status: response.status, remote });
    }
    return response;
  }

  async request<T>(method: string, segments: readonly string[], options: TransportOptions = {}): Promise<T> {
    const response = await this.response(method, segments, options);
    if (response.status === NO_CONTENT) return undefined as T;
    const text = await response.text();
    let value: unknown;
    try { value = JSON.parse(text); }
    catch (cause) { throw new TessarClientError(CLIENT_ERROR_CODE.INVALID_RESPONSE, "Expected a JSON response", { status: response.status, cause }); }
    if (!isObject(value) && !Array.isArray(value))
      throw new TessarClientError(CLIENT_ERROR_CODE.INVALID_RESPONSE, "Expected a JSON resource or collection", { status: response.status });
    return value as T;
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isErrorInfo(value: unknown): value is ErrorInfo {
  return isObject(value) && typeof value.name === "string" && typeof value.code === "string" &&
    typeof value.message === "string" && typeof value.source === "string" && typeof value.retryable === "boolean";
}
