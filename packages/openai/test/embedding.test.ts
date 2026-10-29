import { expect, it } from "vitest";
import OpenAI from "openai";
import { TessarError } from "@tessar/core";
import * as sdk from "../src/index.js";

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
}

function reply(data: unknown): Response {
  return Response.json({ object: "list", model: "fixture", data, usage: { prompt_tokens: 3, total_tokens: 3 } });
}

function fixture(respond: (call: Call) => Response = () => reply([{ index: 0, embedding: [1, 2] }])) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const call = {
      url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers),
    };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch };
}

function encoded(values: number[]): string {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes.toString("base64");
}

it("exports a standalone OpenAIEmbedding and preserves native options, endpoint and ordered results", async () => {
  expect(typeof sdk.OpenAIEmbedding).toBe("function");
  const transport = fixture(() => reply([
    { index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] },
  ]));
  const model = new sdk.OpenAIEmbedding({
    apiKey: "test", model: "fixture", baseURL: "https://embedding.test/v1",
    defaultHeaders: { "x-custom": "value" }, dimensions: 2, user: "user-a",
    encoding_format: "float", timeout: 1000, maxRetries: 0, fetch: transport.fetch,
  });
  expect(await model.embedDocuments(["first\nline", "second"])).toEqual([[1, 2], [3, 4]]);
  expect(transport.calls).toHaveLength(1);
  const call = transport.calls[0]!;
  expect(call.url).toBe("https://embedding.test/v1/embeddings");
  expect(call.body).toEqual({
    model: "fixture", input: ["first\nline", "second"], dimensions: 2,
    user: "user-a", encoding_format: "float",
  });
  expect(call.headers.get("authorization")).toBe("Bearer test");
  expect(call.headers.get("x-custom")).toBe("value");
});

it("retains the installed SDK's default request behavior without adding Tessar defaults", async () => {
  const adapterTransport = fixture();
  const directTransport = fixture();
  const model = new sdk.OpenAIEmbedding({ apiKey: "test", model: "fixture", fetch: adapterTransport.fetch });
  const direct = new OpenAI({ apiKey: "test", fetch: directTransport.fetch });
  expect(await model.embedQuery("question")).toEqual([1, 2]);
  await direct.embeddings.create({ model: "fixture", input: "question" });
  expect(adapterTransport.calls[0]!.body).toEqual(directTransport.calls[0]!.body);
  expect(adapterTransport.calls[0]!.body).not.toHaveProperty("dimensions");
  expect(adapterTransport.calls[0]!.body).not.toHaveProperty("input_type");
});

it("snapshots constructor configuration and document arrays, and supports concurrent calls", async () => {
  const transport = fixture(call => reply([{ index: 0, embedding: call.body.input === "query" ? [3] : [2] }]));
  const configuration = { apiKey: "test", model: "original", dimensions: 1, fetch: transport.fetch };
  const model = new sdk.OpenAIEmbedding(configuration);
  configuration.model = "changed";
  configuration.dimensions = 99;
  const texts = ["original document"];
  const pending = model.embedDocuments(texts);
  texts[0] = "mutated";
  expect(await Promise.all([pending, model.embedQuery("query")])).toEqual([[[2]], [3]]);
  expect(transport.calls.map(call => call.body.input)).toEqual([["original document"], "query"]);
  expect(transport.calls.every(call => call.body.model === "original" && call.body.dimensions === 1)).toBe(true);
});

it("returns [] for an empty document list and rejects wrong runtime inputs", async () => {
  const transport = fixture();
  const model = new sdk.OpenAIEmbedding({ apiKey: "test", model: "fixture", fetch: transport.fetch });
  expect(await model.embedDocuments([])).toEqual([]);
  await expect(model.embedDocuments("text" as never)).rejects.toBeInstanceOf(TessarError);
  await expect(model.embedDocuments([1] as never)).rejects.toBeInstanceOf(TessarError);
  await expect(model.embedQuery(["query"] as never)).rejects.toBeInstanceOf(TessarError);
  expect(transport.calls).toHaveLength(0);
});

it("extracts and snapshots text from document/chunk objects without sending other data", async () => {
  const transport = fixture(() => reply([
    { index: 2, embedding: [3] }, { index: 0, embedding: [1] }, { index: 1, embedding: [2] },
  ]));
  const model = new sdk.OpenAIEmbedding({ apiKey: "test", model: "fixture", fetch: transport.fetch });
  const chunk = {
    text: "first\ntext", format: "text", source: { page: 3 },
    metadata: { internal: "not sent", callback: () => "also not sent" },
    position: { contentIndex: 0, start: 0, end: 10 },
  };
  const other = { text: "third" };
  const pending = model.embedDocuments([chunk, "second", other]);
  chunk.text = "changed";
  other.text = "changed";
  expect(await pending).toEqual([[1], [2], [3]]);
  expect(transport.calls[0]!.body.input).toEqual(["first\ntext", "second", "third"]);
  const serialized = JSON.stringify(transport.calls[0]!.body);
  expect(serialized).not.toMatch(/internal|metadata|source|position|callback/);
});

it.each([[{}], [{ text: 1 }], [null], [undefined], new Array(1)].map(input => ({ input })))(
  "rejects document objects without string text: %j", async ({ input }) => {
    const transport = fixture();
    const model = new sdk.OpenAIEmbedding({ apiKey: "test", model: "fixture", fetch: transport.fetch });
    await expect(model.embedDocuments(input as never)).rejects.toBeInstanceOf(TessarError);
    expect(transport.calls).toHaveLength(0);
  },
);

it.each([undefined, "base64"] as const)("decodes base64 vectors when encoding is %s", async encoding_format => {
  const transport = fixture(() => reply([{ index: 0, embedding: encoded([1.25, -2.5, 0]) }]));
  const model = new sdk.OpenAIEmbedding({
    apiKey: "test", model: "fixture", encoding_format, fetch: transport.fetch,
  });
  expect(await model.embedQuery("question")).toEqual([1.25, -2.5, 0]);
});

it.each([
  undefined, null, {}, [],
  [{ index: 0, embedding: [1] }],
  [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }],
  [{ index: -1, embedding: [1] }, { index: 1, embedding: [2] }],
  [{ index: 0.5, embedding: [1] }, { index: 1, embedding: [2] }],
  [{ index: 0, embedding: [1] }, { index: 2, embedding: [2] }],
  [{ index: 0, embedding: [] }, { index: 1, embedding: [2] }],
  [{ index: 0, embedding: [1] }, { index: 1, embedding: [2, 3] }],
  [{ index: 0, embedding: [null] }, { index: 1, embedding: [2] }],
  [{ index: 0, embedding: ["1"] }, { index: 1, embedding: [2] }],
  [{ index: 0, embedding: [1] }, null],
])("rejects malformed provider data: %j", async data => {
  const transport = fixture(() => reply(data));
  const model = new sdk.OpenAIEmbedding({
    apiKey: "test", model: "fixture", encoding_format: "float", fetch: transport.fetch,
  });
  await expect(model.embedDocuments(["first", "second"])).rejects.toMatchObject({
    name: "TessarError", code: "InvalidData", source: "provider",
  });
});

it.each(["", "AAAA", "@@@@" + encoded([1]), encoded([Infinity])])(
  "rejects malformed explicit base64 vectors: %s", async value => {
    const transport = fixture(() => reply([{ index: 0, embedding: value }]));
    const model = new sdk.OpenAIEmbedding({ apiKey: "test", model: "fixture", encoding_format: "base64", fetch: transport.fetch });
    await expect(model.embedQuery("query")).rejects.toMatchObject({ code: "InvalidData", source: "provider" });
  },
);

it("propagates native OpenAI API errors without wrapping them", async () => {
  const transport = fixture(() => Response.json({
    error: { message: "Invalid key", type: "authentication_error", code: "invalid_api_key", param: null },
  }, { status: 401, headers: { "x-request-id": "request-fixture" } }));
  const model = new sdk.OpenAIEmbedding({ apiKey: "bad", model: "fixture", maxRetries: 0, fetch: transport.fetch });
  let caught: unknown;
  try { await model.embedQuery("query"); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(OpenAI.AuthenticationError);
  expect(caught).not.toBeInstanceOf(TessarError);
  expect(caught).toMatchObject({ status: 401, code: "invalid_api_key", requestID: "request-fixture" });
});

it("uses the SDK retry configuration for transient provider failures", async () => {
  let attempts = 0;
  const transport = fixture(() => ++attempts === 1
    ? Response.json({ error: { message: "Busy" } }, { status: 503, headers: { "retry-after-ms": "1" } })
    : reply([{ index: 0, embedding: [1, 2] }]));
  const model = new sdk.OpenAIEmbedding({ apiKey: "test", model: "fixture", maxRetries: 1, fetch: transport.fetch });
  expect(await model.embedQuery("query")).toEqual([1, 2]);
  expect(attempts).toBe(2);
});

it("uses the SDK timeout error rather than replacing it with a framework error", async () => {
  const model = new sdk.OpenAIEmbedding({
    apiKey: "test", model: "fixture", maxRetries: 0, timeout: 20,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
  });
  await expect(model.embedQuery("query")).rejects.toBeInstanceOf(OpenAI.APIConnectionTimeoutError);
});
