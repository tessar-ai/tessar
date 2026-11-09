import { expect, test, vi } from "vitest";
import { Transport } from "../src/transport.js";
import { TessarClientError } from "../src/errors.js";

test("client errors own their browser-safe error contract", () => {
  const cause = new Error("native");
  const error = new TessarClientError("Example", "message", { cause, status: 400 });
  expect(Object.getPrototypeOf(TessarClientError.prototype)).toBe(Error.prototype);
  expect(error.cause).toBe(cause);
  expect(TessarClientError.isInstance(error)).toBe(true);
  expect(TessarClientError.isInstance(cause)).toBe(false);
  expect(error.toJSON()).toEqual({ source: "tessar", name: "TessarClientError", code: "Example", message: "message", retryable: false });
});

test("preserves prefix, encoded segments, JSON/query and native request options", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
  const signal = new AbortController().signal;
  const transport = new Transport({ baseURL: "https://example.com/tessar/", headers: { Authorization: "Bearer token" }, credentials: "include", fetch: fetcher });
  expect(await transport.request("POST", ["agents", "a /?#", "generate"], { body: { input: "hello", unused: undefined }, query: { scope: { user: "u" }, limit: 2, cursor: undefined }, signal })).toEqual({ ok: true });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe("https://example.com/tessar/api/agents/a%20%2F%3F%23/generate?scope=%7B%22user%22%3A%22u%22%7D&limit=2");
  expect(new Headers(init!.headers).get("authorization")).toBe("Bearer token");
  expect(init).toMatchObject({ credentials: "include", signal, method: "POST", body: '{"input":"hello"}' });
});

test.each(["file:///tmp/db", "https://example.com/?x=1", "https://example.com/#x", "https://example.com/?", "https://example.com/#"])("rejects invalid baseURL %s", baseURL => {
  expect(() => new Transport({ baseURL })).toThrow(TessarClientError);
});

test.each(["null", "42", '"a proxy message"'])("rejects a successful response with no resource container: %s", async text => {
  const transport = new Transport({ baseURL: "http://test", fetch: async () => new Response(text) });
  await expect(transport.request("GET", ["agents"])).rejects.toMatchObject({ code: "InvalidResponse" });
});

test("empty IDs fail before fetch and 204 returns undefined", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const transport = new Transport({ baseURL: "http://test", fetch: fetcher });
  await expect(transport.request("GET", ["agents", " "])).rejects.toBeInstanceOf(TessarClientError);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await transport.request("POST", ["close"])).toBeUndefined();
});

test("HTTP error keeps remote ErrorInfo and status without retrying", async () => {
  const remote = { name: "ProviderError", code: "RateLimit", message: "Slow down", source: "provider", retryable: true };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: remote }, { status: 429 }));
  const transport = new Transport({ baseURL: "http://test", fetch: fetcher });
  const error = await transport.request("POST", ["generate"], { body: {} }).catch(e => e);
  expect(error).toBeInstanceOf(TessarClientError);
  expect(error).toMatchObject({ status: 429, code: "HttpError", remote });
  if (!(error instanceof TessarClientError)) throw error;
  expect(error.toJSON().code).toBe("HttpError");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("handles non-JSON errors and invalid successful JSON without leaking response bodies", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("secret upstream", { status: 502 })).mockResolvedValueOnce(new Response("broken"));
  const transport = new Transport({ baseURL: "http://test", fetch: fetcher });
  await expect(transport.request("GET", ["agents"])).rejects.toMatchObject({ code: "HttpError", status: 502 });
  await expect(transport.request("GET", ["agents"])).rejects.toMatchObject({ code: "InvalidResponse" });
});

test.each([new TypeError("network"), new DOMException("aborted", "AbortError")])("preserves native fetch failures", async failure => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(failure);
  await expect(new Transport({ baseURL: "http://test", fetch: fetcher }).request("POST", ["generate"], { body: {} })).rejects.toBe(failure);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
