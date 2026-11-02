import { expect, it, vi } from "vitest";
import * as sdk from "../src/index.js";
import { TessarError } from "@tessar/core";

function fixture(results: unknown = [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ results }));
  const reranker = new sdk.OpenAIReranker({ endpoint: "https://rerank.test/v1/rerank", apiKey: "test", model: "fixture", fetch });
  return { reranker, fetch };
}

it("sends only text and attaches ranked scores to the original candidates", async () => {
  const { reranker, fetch } = fixture();
  const candidates = [
    { id: "first", content: { text: "one", metadata: { private: true } }, score: 0.99 },
    { id: "second", content: { text: "two", metadata: {} }, score: 0.1 },
  ];
  const ranked = await reranker.rerank("question", candidates);
  expect(ranked).toEqual([{ document: candidates[1], score: 0.9 }, { document: candidates[0], score: 0.2 }]);
  expect(ranked[0]!.document).toBe(candidates[1]);
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe("https://rerank.test/v1/rerank");
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test");
  expect(JSON.parse(String(init?.body))).toEqual({ model: "fixture", query: "question", documents: ["one", "two"], top_n: 2 });
});

it("accepts strings and contents, sorts and applies score threshold", async () => {
  const { reranker } = fixture([{ index: 0, relevance_score: -2 }, { index: 1, relevance_score: 3 }]);
  expect(await reranker.rerank("q", ["one", { text: "two" }], { topK: 2, score_threshold: 0 })).toEqual([
    { document: { text: "two" }, score: 3 },
  ]);
});

it("does not request an empty candidate array", async () => {
  const { reranker, fetch } = fixture();
  expect(await reranker.rerank("q", [])).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it("defaults to five results and snapshots candidate order before awaiting HTTP", async () => {
  const candidates = ["zero", "one", "two", "three", "four", "five"];
  const reranker = new sdk.OpenAIReranker({
    endpoint: "https://rerank.test", apiKey: "test", model: "fixture",
    fetch: async (_url, init) => {
      expect(JSON.parse(String(init?.body)).top_n).toBe(5);
      candidates.reverse();
      return Response.json({ results: [{ index: 0, relevance_score: 1 }] });
    },
  });
  expect(await reranker.rerank("q", candidates)).toEqual([{ document: "zero", score: 1 }]);
});

it.each([
  { endpoint: "invalid", apiKey: "test", model: "fixture" },
  { endpoint: "file:///tmp/rerank", apiKey: "test", model: "fixture" },
  { endpoint: "https://user:pass@rerank.test", apiKey: "test", model: "fixture" },
  { endpoint: "https://rerank.test", apiKey: "", model: "fixture" },
  { endpoint: "https://rerank.test", apiKey: "test", model: "" },
])("rejects invalid configuration %#", options => {
  expect(() => new sdk.OpenAIReranker(options)).toThrow(TessarError);
});

it.each([
  [{ index: 2, relevance_score: 1 }],
  [{ index: 0, relevance_score: "1" }],
  [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0 }],
  null,
])("rejects malformed provider results %#", async results => {
  await expect(fixture(results).reranker.rerank("q", ["one", "two"])).rejects.toMatchObject({ name: "TessarError", code: "InvalidData", source: "provider" });
});

it("validates inputs before calling the provider", async () => {
  const { reranker, fetch } = fixture();
  await expect(reranker.rerank("q", ["one"], { topK: 0 })).rejects.toMatchObject({ code: "InvalidData" });
  await expect(reranker.rerank("q", ["one"], { score_threshold: NaN })).rejects.toMatchObject({ code: "InvalidData" });
  await expect(reranker.rerank("q", [{} as { text: string }])).rejects.toMatchObject({ code: "InvalidData" });
  expect(fetch).not.toHaveBeenCalled();
});

it("preserves transport errors and reports HTTP status without leaking credentials", async () => {
  const error = new Error("offline");
  const options = { endpoint: "https://rerank.test", apiKey: "secret", model: "fixture" };
  await expect(new sdk.OpenAIReranker({ ...options, fetch: async () => { throw error; } }).rerank("q", ["one"])).rejects.toBe(error);
  await expect(new sdk.OpenAIReranker({ ...options, fetch: async () => new Response("secret", { status: 429 }) }).rerank("q", ["one"])).rejects.toMatchObject({ code: "RerankFailed", source: "provider", details: { status: 429 } });
});

it("attributes malformed JSON to the provider while preserving body read errors", async () => {
  const options = { endpoint: "https://rerank.test", apiKey: "test", model: "fixture" };
  await expect(new sdk.OpenAIReranker({ ...options, fetch: async () => new Response("<html>oops</html>") }).rerank("q", ["one"]))
    .rejects.toMatchObject({ name: "TessarError", code: "InvalidData", source: "provider" });
  const error = new Error("connection lost");
  await expect(new sdk.OpenAIReranker({ ...options, fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.error(error); },
  })) }).rerank("q", ["one"])).rejects.toBe(error);
});

it("cancels unread HTTP error bodies without masking the status error", async () => {
  let cancelled = 0;
  const response = new Response(new ReadableStream({
    cancel() { cancelled++; throw new Error("cleanup failed"); },
  }), { status: 429 });
  const reranker = new sdk.OpenAIReranker({
    endpoint: "https://rerank.test", apiKey: "test", model: "fixture", fetch: async () => response,
  });
  await expect(reranker.rerank("q", ["one"])).rejects.toMatchObject({ code: "RerankFailed", details: { status: 429 } });
  expect(cancelled).toBe(1);
});
