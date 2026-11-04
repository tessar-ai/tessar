import { expect, it } from "vitest";
import { OpenAIEmbedding } from "../src/index.js";

function response(input: string[], dimensions = 1): Response {
  return Response.json({ data: input.map((text, index) => ({ index, embedding: Array(dimensions).fill(Number(text)) })).reverse() });
}

it("splits 101 documents at 100 without changing text or sending scheduler options", async () => {
  const inputs: string[][] = [];
  const embedding = new OpenAIEmbedding({
    apiKey: "test", model: "fixture", batchSize: 100,
    documentOptions: { task: "passage" },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).not.toHaveProperty("batchSize");
      expect(body).not.toHaveProperty("concurrency");
      expect(body.task).toBe("passage");
      inputs.push(body.input);
      return response(body.input);
    },
  });
  const texts = Array.from({ length: 101 }, (_, i) => String(i));
  expect(await embedding.embedDocuments(texts)).toEqual(texts.map(Number).map(value => [value]));
  expect(inputs).toEqual([texts.slice(0, 100), texts.slice(100)]);
});

it("bounds concurrency and preserves order with out-of-order responses", async () => {
  const pending = new Map<string, (response: Response) => void>();
  let started = 0;
  const waitFor = async (count: number) => {
    await expect.poll(() => started).toBe(count);
  };
  const embedding = new OpenAIEmbedding({
    apiKey: "test", model: "fixture", batchSize: 1, concurrency: 2,
    fetch: async (_url, init) => {
      const input = JSON.parse(String(init?.body)).input as string[];
      started++;
      return new Promise(resolve => pending.set(input[0]!, resolve));
    },
  });
  const texts = ["0", "1", "2"];
  const result = embedding.embedDocuments(texts);
  texts[2] = "changed";
  await waitFor(2);
  pending.get("1")!(response(["1"]));
  await waitFor(3);
  pending.get("2")!(response(["2"]));
  pending.get("0")!(response(["0"]));
  expect(await result).toEqual([[0], [1], [2]]);
});

it("stops scheduling on failure and preserves the provider error", async () => {
  let requests = 0;
  const embedding = new OpenAIEmbedding({
    apiKey: "test", model: "fixture", batchSize: 1, maxRetries: 0,
    fetch: async () => { requests++; return Response.json({ error: { message: "limit", type: "bad_request" } }, { status: 400 }); },
  });
  await expect(embedding.embedDocuments(["0", "1", "2"])).rejects.toMatchObject({ status: 400 });
  expect(requests).toBe(1);
});

it("settles running requests after a failure without starting more batches", async () => {
  let requests = 0;
  const running = Promise.withResolvers<Response>();
  const embedding = new OpenAIEmbedding({
    apiKey: "test", model: "fixture", batchSize: 1, concurrency: 2, maxRetries: 0,
    fetch: async () => {
      requests++;
      return requests === 1
        ? Response.json({ error: { message: "bad input" } }, { status: 400 })
        : running.promise;
    },
  });
  const result = embedding.embedDocuments(["0", "1", "2", "3"]);
  const rejected = expect(result).rejects.toMatchObject({ status: 400 });
  await expect.poll(() => requests).toBe(2);
  await new Promise<void>(resolve => setImmediate(resolve));
  running.resolve(response(["1"]));
  await rejected;
  expect(requests).toBe(2);
});

it("leaves query calls and unbatched defaults unchanged", async () => {
  const inputs: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)).input;
    inputs.push(input);
    return response(typeof input === "string" ? [input] : input);
  };
  await new OpenAIEmbedding({ apiKey: "test", model: "fixture", concurrency: 2, fetch }).embedDocuments(["0", "1", "2"]);
  const embedding = new OpenAIEmbedding({ apiKey: "test", model: "fixture", batchSize: 1, concurrency: 2, fetch });
  expect(await embedding.embedDocuments([])).toEqual([]);
  expect(await embedding.embedQuery("3")).toEqual([3]);
  expect(inputs).toEqual([["0", "1", "2"], "3"]);
});

it("rejects different vector dimensions across batches", async () => {
  let requests = 0;
  const embedding = new OpenAIEmbedding({
    apiKey: "test", model: "fixture", batchSize: 1,
    fetch: async (_url, init) => response(JSON.parse(String(init?.body)).input, ++requests),
  });
  await expect(embedding.embedDocuments(["0", "1"])).rejects.toMatchObject({ code: "InvalidData", source: "provider" });
});

it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, null])("rejects invalid batch configuration %s", value => {
  for (const key of ["batchSize", "concurrency"])
    expect(() => new OpenAIEmbedding({ apiKey: "test", model: "fixture", [key]: value } as never)).toThrow();
});
