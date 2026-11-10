import { startServer as bootstrap } from "../../cli/src/development/server.js";
import { TessarServer } from "../src/framework/hono.js";
import { vi } from "vitest";
import { Agent, Controller } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { Tessar } from "../src/index.js";
import type { TessarOptions } from "../src/index.js";

export async function start<User = unknown>(options: TessarOptions<User> = {}) {
  let resolve!: (url: string) => void;
  const listening = new Promise<string>(done => { resolve = done; });
  const log = vi.spyOn(console, "log").mockImplementation(value => {
    const match = String(value).match(/http:\/\/[^ ]+/);
    if (match) resolve(match[0]);
  });
  const tessar = new Tessar<User>({
    ...(options.agents === undefined && options.controllers === undefined ? {
      controllers: [new Controller({ id: crypto.randomUUID(), agent: new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([{ text: "Hello" }]) }) })],
    } : {}),
    ...options, server: { port: 0, ...options.server }
  });
  const server = await startServer(tessar);
  const url = await listening;
  log.mockRestore();
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

export function startServer(tessar: Tessar<any>) { return bootstrap(tessar, app => new TessarServer({ app, tessar })); }
