import fastify from "fastify";
import { expect, test } from "vitest";
import { Agent, Controller } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { TessarClient } from "@tessar/client";
import { TessarServer } from "../src/framework/fastify.js";
import { Tessar } from "../src/index.js";

test("mounts native routes under the app's prefix and preserves host ownership", async () => {
  const app = fastify({ bodyLimit: 128 });
  const model = new ScriptedProvider([{ text: "done" }]);
  const agent = new Agent({ id: "assistant", model });
  const tessar = new Tessar({ agents: [agent], server: {
    fastifyOptions: { bodyLimit: 1024 },
    configure() { throw Error("Self-host configuration must not run inside the application"); },
  } });
  let server: TessarServer | undefined;
  app.get("/business", async () => ({ business: true }));
  app.register(async scope => {
    scope.addHook("onRequest", async (request, reply) => {
      if (request.headers.authorization !== "Bearer local") return reply.code(401).send({ denied: true });
    });
    server = new TessarServer({ app: scope, tessar, prefix: "/tessar" });
    expect(server.init()).toBe(server.init());
    await server.init();
  }, { prefix: "/v1" });
  const base = "/v1/tessar";
  const headers = { authorization: "Bearer local" };
  try {
    expect((await app.inject(base + "/api/agents")).statusCode).toBe(401);
    expect(app.server.listening).toBe(false);
    expect((await app.inject({ url: base + "/api/agents", headers })).json()).toMatchObject([{ id: agent.id }]);
    const doc = (await app.inject({ url: base + "/openapi.json", headers })).json();
    expect(doc.paths[base + "/api/agents"]).toBeDefined();
    const oversized = await app.inject({ method: "POST", url: base + "/api/agents/assistant/generate", headers, payload: { input: "x".repeat(256) } });
    expect(oversized.statusCode).toBe(413);
    expect(model.calls).toHaveLength(0);
    await server!.shutdown();
    expect((await app.inject({ url: base + "/api/agents", headers })).statusCode).toBe(503);
    expect((await app.inject("/business")).json()).toEqual({ business: true });
    expect((await agent.generate("SDK still works")).status).toBe("completed");
  } finally { await app.close(); await tessar.shutdown(); }
});

test("application shutdown closes mounted Tessar SSE without disposing the runtime", async () => {
  const app = fastify();
  const controller = new Controller({ id: "main", agent: new Agent({ id: "assistant", model: new ScriptedProvider([]) }) });
  const tessar = new Tessar({ controllers: [controller] });
  const server = new TessarServer({ app, tessar, prefix: "/tessar" });
  await server.init();
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const session = await new TessarClient({ baseURL: url + "/tessar" }).getController("main").createSession();
    await session.thread.create();
    const stream = await fetch(`${url}/tessar/api/controllers/main/sessions/${session.id}/state/stream`);
    const reader = stream.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const ended = reader.read().then(result => result.done, () => true);
    await app.close();
    expect(await ended).toBe(true);
    expect(controller.isReady()).toBe(true);
  } finally { await server.shutdown(); await app.close(); await tessar.shutdown(); }
});
