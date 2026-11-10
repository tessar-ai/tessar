import { startServer } from "./helpers.js";
import { afterEach, expect, test } from "vitest";
import { Agent } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { Tessar, registerMiddleware, registerRoute } from "../src/index.js";

const agents: Agent[] = [];
afterEach(async () => { for (const agent of agents) await agent.shutdown(); });
function agent() {
  const value = new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([]) });
  agents.push(value);
  return value;
}

test("rejects empty runtimes and invalid configuration before bootstrap", () => {
  expect(() => new Tessar({})).toThrow();
  expect(() => new Tessar({ agents: [agent()], server: { port: -1 } })).toThrow();
  expect(() => new Tessar({ agents: [agent()], surprise: true } as never)).toThrow();
});

test("validates declarations and prevents duplicate runtime registration", () => {
  expect(() => registerRoute("health", { method: "GET", handler: c => c.text("ok") })).toThrow();
  expect(() => registerRoute("/health", { method: "BOGUS", handler: () => new Response("ok") } as never)).toThrow();
  expect(() => registerMiddleware("bad", async (_, next) => next())).toThrow();
  const value = agent();
  expect(() => new Tessar({ agents: [value, value] })).toThrow();
});

test("rejects collisions with built-in endpoints before listening", async () => {
  const tessar = new Tessar({
    agents: [agent()], server: {
      routes: [
        registerRoute("/api/agents", { method: "GET", handler: c => c.text("override") }),
      ]
    }
  });
  await expect(startServer(tessar)).rejects.toThrow();
});
