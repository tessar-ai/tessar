import { afterEach, expect, test } from "vitest";
import { Hono } from "hono";
import { Agent, Controller } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { Tessar } from "../src/index.js";
import { TessarServer } from "../src/framework/hono.js";
import express from "express";
import { TessarServer as ExpressServer } from "../src/framework/express.js";
import { TessarServerAdapter, type TessarRequestHandler } from "../src/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test("Hono integration exposes prefixed APIs and OpenAPI alongside application routes", async () => {
  const agent = new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([{ text: "hello" }]) });
  const tessar = new Tessar({ agents: [agent] });
  cleanup.push(() => tessar.shutdown());
  expect(tessar.getAgent(agent.id)).toBe(agent);
  expect(tessar.getController(agent.id).agent).toBe(agent);
  expect(() => tessar.getAgent("missing")).toThrow();
  const app = new Hono(); app.get("/business", c => c.text("business"));
  const server = new TessarServer({ app, tessar, prefix: "/tessar" });
  cleanup.push(() => server.shutdown());
  expect(server.init()).toBe(server.init());
  await server.init();
  expect((await app.request("/business")).status).toBe(200);
  expect((await app.request("/api/agents")).status).toBe(404);
  expect((await (await app.request("/tessar/api/agents")).json())[0].id).toBe(agent.id);
  const doc = await (await app.request("/tessar/openapi.json")).json();
  expect(doc.openapi).toBe("3.1.0");
  expect(doc.paths["/tessar/api/agents/{agentId}/generate"].post.requestBody).toBeDefined();
  await server.shutdown();
  expect((await app.request("/tessar/api/agents")).status).toBe(503);
  expect((await app.request("/business")).status).toBe(200);
  expect((await agent.generate("direct SDK still works")).status).toBe("completed");
});

test("Express handles parsed JSON, unparsed JSON and streaming without owning the application", async () => {
  for (const parsed of [true, false]) {
    const agent = new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([{ text: "express answer" }, { text: "stream answer" }]) });
    const tessar = new Tessar({ agents: [agent] }); cleanup.push(() => tessar.shutdown());
    const app = express(); if (parsed) app.use(express.json());
    const seen: string[] = [];
    app.use((_, response, next) => { seen.push("auth"); response.setHeader("x-test", "application"); next(); });
    const adapter = new ExpressServer({ app, tessar, prefix: "/tessar" });
    cleanup.push(() => adapter.shutdown());
    await adapter.init();
    app.get("/business", (_, response) => { response.json({ business: true }); });
    const listener = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => listener.once("listening", resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => { listener.close(error => error ? reject(error) : resolve()); listener.closeAllConnections(); }));
    const address = listener.address(); if (!address || typeof address === "string") throw Error("No port");
    const url = `http://127.0.0.1:${address.port}`;
    const call = (path: string, value: unknown) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    const generated = await call(`/tessar/api/agents/${agent.id}/generate`, { input: "hello" });
    expect(generated.headers.get("x-test")).toBe("application");
    const generatedText = await generated.text();
    expect(generated.status, generatedText).toBe(200);
    expect(generatedText).toContain("express answer");
    expect(JSON.parse(generatedText).status).toBe("completed");
    const response = await call(`/tessar/api/agents/${agent.id}/stream`, { input: "stream" });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("stream answer");
    expect(await (await fetch(url + "/business")).json()).toEqual({ business: true });
    expect(seen.length).toBe(3);
    await adapter.shutdown();
    expect((await fetch(url + "/tessar/api/agents")).status).toBe(503);
    expect((await fetch(url + "/business")).status).toBe(200);
  }
});

test("custom adapters register once, keep shared runtime ownership, and preserve registration failure", async () => {
  class Custom extends TessarServerAdapter<{ calls: number; handler?: TessarRequestHandler }> {
    protected registerHandler(handler: TessarRequestHandler) { this.app.calls++; this.app.handler = handler; }
  }
  const tessar = new Tessar({ agents: [new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([]) })] });
  cleanup.push(() => tessar.shutdown());
  const a = { calls: 0, handler: undefined as TessarRequestHandler | undefined }, b = { ...a };
  const first = new Custom({ app: a, tessar }), second = new Custom({ app: b, tessar });
  cleanup.push(() => first.shutdown(), () => second.shutdown());
  await Promise.all([first.init(), first.init(), second.init()]);
  expect(a.calls).toBe(1);
  await first.shutdown();
  expect((await b.handler!(new Request("http://test/api/agents"))).status).toBe(200);
  await expect(first.init()).rejects.toMatchObject({ code: "Disposed" });
  const failure = new Error("framework registration failed");
  class Broken extends Custom { protected override registerHandler(): never { throw failure; } }
  const broken = new Broken({ app: { calls: 0 }, tessar });
  await expect(broken.init()).rejects.toBe(failure);
  await broken.shutdown();
  expect((await b.handler!(new Request("http://test/api/agents"))).status).toBe(200);
});

test("adapter shutdown during runtime initialization never registers a handler or disposes shared runtime", async () => {
  const gate = Promise.withResolvers<void>();
  const controller = new Controller({
    id: crypto.randomUUID(),
    agent: new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([]) }),
    plugins: [{ id: "gate", setup: async () => { await gate.promise; } }],
  });
  const tessar = new Tessar({ controllers: [controller] }); cleanup.push(() => tessar.shutdown());
  class Custom extends TessarServerAdapter<{ registrations: number }> {
    protected registerHandler() { this.app.registrations++; }
  }
  const app = { registrations: 0 };
  const adapter = new Custom({ app, tessar });
  const initialization = expect(adapter.init()).rejects.toMatchObject({ code: "Disposed" });
  const stopped = adapter.shutdown();
  gate.resolve();
  await initialization; await stopped;
  expect(app.registrations).toBe(0);
  expect(controller.isReady()).toBe(true);
});

test("adapter initialization preserves the original plugin failure and releases owned runtime resources", async () => {
  const failure = new Error("setup failure");
  const controller = new Controller({
    id: crypto.randomUUID(),
    agent: new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([]) }),
    plugins: [{ id: "failure", setup() { throw failure; } }],
  });
  const tessar = new Tessar({ controllers: [controller] }); cleanup.push(() => tessar.shutdown());
  const adapter = new TessarServer({ app: new Hono(), tessar });
  await expect(adapter.init()).rejects.toBe(failure);
  await adapter.shutdown();
  expect(controller.isReady()).toBe(false);
});
