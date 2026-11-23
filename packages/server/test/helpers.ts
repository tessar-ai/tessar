import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { once } from "node:events";
import type { Server } from "node:http";
import { TessarServer } from "../src/framework/hono.js";
import { Agent, Controller } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { Tessar } from "../src/index.js";
import type { TessarOptions } from "../src/index.js";

export async function start<User = unknown>(options: TessarOptions<User> = {}, boot = startServer) {
  const tessar = new Tessar<User>({
    ...(options.agents === undefined && options.controllers === undefined ? {
      controllers: [new Controller({ id: crypto.randomUUID(), agent: new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([{ text: "Hello" }]) }) })],
    } : {}),
    ...options, server: { port: 0, ...options.server }
  });
  const server = await boot(tessar);
  const { url } = server;
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(url + path, {
      method, ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      })
    });
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  };
  return { server, url, request };
}

export async function startServer(tessar: Tessar<any>) {
  const app = new Hono();
  const hostname = "127.0.0.1";
  let adapter: TessarServer | undefined;
  const listener = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false }) as Server;
  let disposal: Promise<void> | undefined;
  const shutdown = () => disposal ??= (async () => {
    await adapter?.shutdown();
    const closed = listener.listening ? once(listener, "close") : undefined;
    if (closed) {
      listener.close();
      listener.closeAllConnections();
    }
    await Promise.all([closed, tessar.shutdown()]);
  })();
  try {
    adapter = new TessarServer({ app, tessar });
    await adapter.init();
    listener.listen(tessar.server.port ?? 0, hostname);
    await once(listener, "listening");
    const address = listener.address();
    if (!address || typeof address === "string") throw Error("Expected a TCP listener");
    return { url: `http://${hostname}:${address.port}`, shutdown };
  } catch (error) { await shutdown(); throw error; }
}
