import { expect, test } from "vitest";
import { Agent, Controller } from "@tessar/core";
import { request as httpRequest } from "node:http";
import { connect } from "node:http2";
import { ScriptedProvider } from "@tessar/core/testing";
import { TessarClient } from "@tessar/client";
import { Tessar } from "../src/index.js";
import { startSelfHost } from "../src/framework/self-host.js";

test("serves Fastify plugins and Tessar routes in the configured prefix", async () => {
  const tessar = new Tessar({
    agents: [new Agent({ id: "assistant", model: new ScriptedProvider([]) })],
    server: {
      port: 0, prefix: "/t", fastifyOptions: { genReqId: () => "host-request" },
      configure(app) {
        app.decorate("serviceName", "test");
        app.addHook("onRequest", async (request, reply) => { reply.header("x-request-id", request.id); });
        app.setErrorHandler((_error, _request, reply) => { reply.code(418).send({ custom: true }); });
        app.register(async plugin => {
          plugin.get("/health", async () => ({ name: plugin.getDecorator("serviceName") }));
          plugin.get("/broken", async () => { throw Error("broken"); });
          plugin.get("/api/*", async () => ({ customFallback: true }));
        });
      },
    },
  });
  const host = await startSelfHost(tessar);
  try {
    const health = await fetch(host.url + "/t/health");
    expect(await health.json()).toEqual({ name: "test" });
    expect(health.headers.get("x-request-id")).toBe("host-request");
    const agents = await fetch(host.url + "/t/api/agents");
    expect(await agents.json()).toMatchObject([{ id: "assistant" }]);
    expect(agents.headers.get("x-request-id")).toBe("host-request");
    expect((await fetch(host.url + "/t/openapi.json").then(r => r.json())).openapi).toBe("3.1.0");
    expect(await fetch(host.url + "/t/broken").then(r => r.json())).toEqual({ custom: true });
    const missing = await fetch(host.url + "/t/api/agents/missing");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "NotFound" } });
    expect(await fetch(host.url + "/t/api/custom").then(r => r.json())).toEqual({ customFallback: true });
    const head = await fetch(host.url + "/t/api/agents", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  } finally { await host.shutdown(); }
});

test("preserves request bytes for auth and the established JSON/body error contract", async () => {
  const payload = '{ "input": "' + "a".repeat(1024 * 1024) + '" }';
  const bodies: string[] = [];
  const host = await startSelfHost(new Tessar({
    agents: [new Agent({ id: "assistant", model: new ScriptedProvider([{ text: "done" }]) })],
    server: { port: 0, auth: {
      provider: { async authenticate(request) {
        if (!request.headers.has("x-user")) return null;
        bodies.push(await request.text());
        return { id: "alice" };
      } },
      async authorize({ request }) { bodies.push(await request.text()); return true; },
      scope: user => ({ owner: user.id }),
    } },
  }));
  const generate = (body: string, authenticated = true) => fetch(host.url + "/api/agents/assistant/generate", {
    method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { "x-user": "alice" } : {}) }, body,
  });
  try {
    const result = await generate(payload);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: "completed" });
    expect(bodies).toEqual([payload, payload]);
    const denied = await generate("{", false);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: { code: "Unauthorized" } });
    const malformed = await generate("{");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "InvalidRequest" } });
    const oversized = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const request = httpRequest(host.url + "/api/agents/assistant/generate", {
        method: "POST", headers: { "content-type": "application/json", "content-length": 16 * 1024 * 1024 + 1 },
      }, async response => {
        try {
          let body = "";
          for await (const chunk of response) body += chunk;
          resolve({ status: response.statusCode, body });
        } catch (error) { reject(error); }
      });
      request.once("error", reject);
      request.end();
    });
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.body)).toMatchObject({ error: { code: "PayloadTooLarge" } });
  } finally { await host.shutdown(); }
});

test("disconnect detaches a viewer, while shutdown closes an open SSE connection", async () => {
  const gate = Promise.withResolvers<void>();
  const model = new ScriptedProvider([{ text: "done", gate: gate.promise }]);
  const controller = new Controller({ id: "main", agent: new Agent({ id: "assistant", model }) });
  const host = await startSelfHost(new Tessar({ controllers: [controller], server: { port: 0,
    configure(app) {
      app.addHook("onSend", async (request, reply, payload) => {
        if (request.headers["x-slow-viewer"]) {
          const write = reply.raw.write.bind(reply.raw);
          reply.raw.write = ((chunk: Uint8Array) => {
            write(chunk);
            // Simulate Fastify waiting for drain after forwarding the first event.
            return false;
          }) as typeof reply.raw.write;
        }
        return payload;
      });
    },
  } }));
  const client = new TessarClient({ baseURL: host.url });
  const session = await client.getController("main").createSession();
  try {
    await session.thread.create();
    const first = (await session.state.stream())[Symbol.asyncIterator]();
    expect((await first.next()).done).toBe(false);
    await session.followUp("keep running");
    await expect.poll(() => model.calls.length).toBe(1);
    await first.return?.();
    gate.resolve();
    await expect.poll(async () => (await session.state.get()).status).toBe("completed");
    const response = await fetch(host.url + `/api/controllers/main/sessions/${session.id}/state/stream`, {
      headers: { "x-slow-viewer": "true" },
    });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const ended = reader.read().then(result => result.done, () => true);
    await host.shutdown();
    expect(await ended).toBe(true);
  } finally { gate.resolve(); await host.shutdown(); }
});

test("auth sees a disconnect after the POST body has arrived", async () => {
  const began = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const host = await startSelfHost(new Tessar({
    agents: [new Agent({ id: "assistant", model: new ScriptedProvider([]) })],
    server: { port: 0, auth: { provider: { async authenticate(request) {
      await request.text();
      began.resolve(request.signal);
      await release.promise;
      return null;
    } } } },
  }));
  const stop = new AbortController();
  const call = fetch(host.url + "/api/agents/assistant/generate", {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"input":"prompt"}', signal: stop.signal,
  }).catch(() => undefined);
  try {
    const signal = await began.promise;
    stop.abort();
    await expect.poll(() => signal.aborted).toBe(true);
  } finally { stop.abort(); release.resolve(); await call; await host.shutdown(); }
});

test("passes HTTP/2 constructor options to Fastify", async () => {
  const host = await startSelfHost(new Tessar({
    agents: [new Agent({ id: "assistant", model: new ScriptedProvider([]) })],
    server: { port: 0, fastifyOptions: { http2: true } },
  }));
  const client = connect(host.url);
  try {
    const stream = client.request({ ":path": "/api/agents" });
    let body = "";
    for await (const chunk of stream) body += chunk;
    expect(JSON.parse(body)).toMatchObject([{ id: "assistant" }]);
  } finally { client.close(); await host.shutdown(); }
});

test("routes registered Tessar IDs longer than Fastify's default parameter limit", async () => {
  const id = "assistant-" + "a".repeat(110);
  const host = await startSelfHost(new Tessar({
    agents: [new Agent({ id, model: new ScriptedProvider([]) })], server: { port: 0 },
  }));
  try {
    const response = await fetch(host.url + "/api/agents/" + id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id });
  } finally { await host.shutdown(); }
});
