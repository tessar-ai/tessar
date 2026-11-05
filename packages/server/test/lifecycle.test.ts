import { startServer } from "./helpers.js";
import { afterEach, expect, test, vi } from "vitest";
import { Agent, Controller } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { Tessar, registerMiddleware, registerRoute } from "../src/index.js";
import Database from "libsql";
import { LibsqlStoragePlugin } from "@tessar/libsql";

const servers: { shutdown(): Promise<void> }[] = [];
afterEach(async () => { await Promise.all(servers.map(server => server.shutdown())); vi.restoreAllMocks(); });

export async function start(options: Partial<ConstructorParameters<typeof Tessar>[0]> = {}) {
  let resolve!: (url: string) => void;
  const listening = new Promise<string>(done => { resolve = done; });
  vi.spyOn(console, "log").mockImplementation(value => {
    const match = String(value).match(/http:\/\/[^ ]+/);
    if (match) resolve(match[0]);
  });
  const tessar = new Tessar({
    agents: [new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([]) })], ...options,
    server: { port: 0, ...options.server }
  });
  const server = await startServer(tessar);
  servers.push(server);
  return { server, url: await listening };
}

test("auto boots and applies middleware in declaration order to built-in and custom routes", async () => {
  const order: string[] = [];
  const middleware = (name: string) => registerMiddleware("*", async (_, next) => {
    order.push(name); await next(); order.push("after " + name);
  });
  const { url, server } = await start({
    server: {
      middlewares: [middleware("one"), middleware("two")],
      routes: [registerRoute("/health", { method: "GET", handler: c => c.json({ ok: true }) })]
    }
  });
  expect(await (await fetch(url + "/health")).json()).toEqual({ ok: true });
  expect(order).toEqual(["one", "two", "after two", "after one"]);
  order.length = 0;
  expect((await fetch(url + "/api/agents")).status).toBe(200);
  expect(order).toEqual(["one", "two", "after two", "after one"]);
  await server.shutdown();
  await server.shutdown();
});

test("short circuit preserves developer response", async () => {
  const { url } = await start({ server: { middlewares: [registerMiddleware("*", async c => c.text("private", 401))] } });
  const response = await fetch(url + "/api/agents");
  expect(response.status).toBe(401);
  expect(await response.text()).toBe("private");
});

test("shutdown during initialization prevents listening and disposes supplied Controller", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = new Controller({
    id: crypto.randomUUID(),
    agent: new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([]) }),
    plugins: [{ id: "gate", async setup() { await gate; } }],
  });
  const tessar = new Tessar({ controllers: [controller], server: { port: 0 } });
  servers.push(tessar);
  const closed = tessar.shutdown();
  release();
  await closed;
  expect(controller.isReady()).toBe(false);
});

test("host shutdown leaves the developer database connection open", async () => {
  const database = new Database(":memory:");
  const close = vi.spyOn(database, "close");
  try {
    const controller = new Controller({
      id: crypto.randomUUID(), agent: new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([]) }),
      plugins: [new LibsqlStoragePlugin({ database })]
    });
    const { server } = await start({ agents: [], controllers: [controller] });
    await server.shutdown();
    expect(close).not.toHaveBeenCalled();
    expect(database.prepare("SELECT 1 AS value").get()).toMatchObject({ value: 1 });
  } finally { close.mockRestore(); database.close(); }
});

test("invalid adapter configuration during standalone startup disposes its runtime", async () => {
  let disposed = 0;
  const controller = new Controller({ id: crypto.randomUUID(),
    agent: new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([]) }),
    plugins: [{ id: "owned", setup(context) { context.defer(() => { disposed++; }); } }],
  });
  const tessar = new Tessar({ controllers: [controller], server: { prefix: "/bad/" } });
  servers.push(tessar);
  await expect(startServer(tessar)).rejects.toMatchObject({ code: "InvalidConfiguration" });
  expect(controller.isReady()).toBe(false);
  expect(disposed).toBe(1);
});
