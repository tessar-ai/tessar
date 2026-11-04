import { afterEach, expect, test } from "vitest";
import { Agent, Controller } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { RuntimeRegistry } from "../src/runtime/runtime-registry.js";
import { SessionRegistry } from "../src/runtime/session-registry.js";

let runtime: RuntimeRegistry;
afterEach(async () => { await runtime?.dispose(); });
test("coalesces restoration and keeps one live Session until explicit close", async () => {
  const controller = new Controller({ id: crypto.randomUUID(), agent: new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([]) }) });
  runtime = new RuntimeRegistry({ controllers: [controller] });
  await controller.initialize();
  const original = await controller.createSession();
  const id = original.id;
  await original.dispose();
  const sessions = new SessionRegistry(runtime);
  const [a, b] = await Promise.all([sessions.get(controller.id, id), sessions.get(controller.id, id)]);
  expect(a).toBe(b);
  const thread = await a.thread.create();
  expect((await sessions.get(controller.id, id)).thread.getId()).toBe(thread.id);
  await sessions.close(controller.id, id);
  const restored = await sessions.get(controller.id, id);
  expect(restored).not.toBe(a);
  expect(restored.thread.getId()).toBe(thread.id);
});
