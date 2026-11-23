import { afterEach, expect, test } from "vitest";
import { Agent } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import * as server from "../src/index.js";

const agents: Agent[] = [];
afterEach(async () => { for (const agent of agents) await agent.shutdown(); });
function agent() {
  const value = new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([]) });
  agents.push(value);
  return value;
}

test("rejects empty runtimes and invalid configuration before bootstrap", () => {
  expect(() => new server.Tessar({})).toThrow();
  expect(() => new server.Tessar({ agents: [agent()], server: { port: -1 } })).toThrow();
  expect(() => new server.Tessar({ agents: [agent()], surprise: true } as never)).toThrow();
});

test("hosts register their own application routes and middleware", () => {
  expect(server).not.toHaveProperty("registerRoute");
  expect(server).not.toHaveProperty("registerMiddleware");
  for (const name of ["routes", "middlewares"])
    expect(() => new server.Tessar({ agents: [agent()], server: { [name]: [] } })).toThrow("Unexpected configuration fields");
});

test("prevents duplicate runtime registration", () => {
  const value = agent();
  expect(() => new server.Tessar({ agents: [value, value] })).toThrow();
});
