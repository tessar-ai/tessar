import { expect, test } from "vitest";
import { Hono } from "hono";
import { body, httpError, readHonoJson } from "../src/http/protocol.js";
import { Agent } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { RuntimeContext } from "../src/runtime/context.js";
import { ServerApplication } from "../src/http/application.js";
import { start } from "./helpers.js";

function application() {
  const app = new Hono(); app.onError(httpError);
  app.post("/", async c => c.json(await body({ readJson: () => readHonoJson(c) }, ["input"])));
  return app;
}

test("rejects an oversized declared body before reading it", async () => {
  let cancelled = false, reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) { reads++; c.enqueue(new TextEncoder().encode("{}")); c.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const response = await application().request("/", {
    method: "POST", headers: {
      "content-type": "application/json", "content-length": String(17 * 1024 * 1024),
    }, body: stream, duplex: "half"
  } as RequestInit);
  expect(response.status).toBe(413);
  expect((await response.json()).error.code).toBe("PayloadTooLarge");
  expect(reads).toBe(0); expect(cancelled).toBe(true);
});

test.each([undefined, "1"])("stops oversized streamed input despite content-length %s", async length => {
  let reads = 0, cancelled = false;
  const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
  const stream = new ReadableStream<Uint8Array>({
    pull(c) { if (++reads <= 20) c.enqueue(chunk); else c.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (length !== undefined) headers["content-length"] = length;
  const response = await application().request("/", { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
  expect(response.status).toBe(413); expect(reads).toBeLessThan(20); expect(cancelled).toBe(true);
});

test("counts UTF-8 bytes and preserves ordinary JSON and malformed-body errors", async () => {
  const app = application();
  const large = await app.request("/", { method: "POST", body: JSON.stringify({ input: "\u20ac".repeat(6 * 1024 * 1024) }) });
  expect(large.status).toBe(413);
  const valid = await app.request("/", { method: "POST", body: JSON.stringify({ input: "Xin chào" }) });
  expect(valid.status).toBe(200); expect(await valid.json()).toEqual({ input: "Xin chào" });
  const invalid = await app.request("/", { method: "POST", body: "{" });
  expect(invalid.status).toBe(400); expect((await invalid.json()).error.code).toBe("InvalidRequest");
});

test("supports a body already cached by a developer middleware", async () => {
  const app = application();
  app.use("/cached", async (c, next) => { await c.req.json(); await next(); });
  app.post("/cached", async c => c.json(await body({ readJson: () => readHonoJson(c) }, ["input"])));
  const response = await app.request("/cached", { method: "POST", body: JSON.stringify({ input: "cached" }) });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ input: "cached" });
});

test("bounds request clones inspected by authentication before the route handler", async () => {
  let reads = 0, authCalls = 0;
  const model = new ScriptedProvider([{ text: "unused" }]);
  const agent = new Agent({ id: crypto.randomUUID(), model });
  const runtime = new RuntimeContext({ agents: [agent] });
  await runtime.ready();
  const application = new ServerApplication(runtime, {
    auth: {
      provider: {
        async authenticate(request) { authCalls++; await request.json(); return { id: "user" }; },
      }
    }
  });
  const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      reads++;
      if (reads === 1) c.enqueue(new TextEncoder().encode('{"input":"'));
      else if (reads <= 21) c.enqueue(chunk);
      else { c.enqueue(new TextEncoder().encode('"}')); c.close(); }
    },
  }, { highWaterMark: 0 });
  try {
    const response = await application.app.request(`/api/agents/${agent.id}/generate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
    expect(reads).toBeLessThan(20); expect(authCalls).toBe(1); expect(model.calls).toHaveLength(0);
  } finally { application.shutdown(); await runtime.shutdown(); }
});

test.each([false, true])("returns 413 over a real HTTP connection (chunked: %s)", async chunked => {
  const host = await start();
  const text = JSON.stringify({ input: "x".repeat(17 * 1024 * 1024) });
  const encoder = new TextEncoder(); let offset = 0;
  const data = chunked ? new ReadableStream<Uint8Array>({
    pull(c) {
      if (offset === text.length) { c.close(); return; }
      const next = text.slice(offset, offset + 64 * 1024); offset += next.length; c.enqueue(encoder.encode(next));
    },
  }) : text;
  try {
    const response = await fetch(host.url + "/api/agents/missing/generate", {
      method: "POST", headers: { "content-type": "application/json" }, body: data, duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413); expect((await response.json()).error.code).toBe("PayloadTooLarge");
  } finally { await host.server.shutdown(); }
});
