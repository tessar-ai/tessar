import { expect, test, vi } from "vitest";
import { Agent, Controller } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { RuntimeRegistry } from "../src/runtime/runtime-registry.js";
import { SessionRegistry } from "../src/runtime/session-registry.js";

test.each(["bob", "alice"])("concurrent cold Session access checks each caller's scope (%s first)", async first => {
  const controller = new Controller({
    id: crypto.randomUUID(), agent: new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([]) }),
  });
  await controller.initialize();
  const session = await controller.createSession({ scope: { userId: "alice" } });
  await session.dispose();
  const ready = Promise.withResolvers<void>();
  const restore = controller.getSession.bind(controller);
  vi.spyOn(controller, "getSession").mockImplementation(async (...args) => { await ready.promise; return restore(...args); });
  const registry = new SessionRegistry(new RuntimeRegistry({ controllers: [controller] }));
  try {
    const users = [first, "alice", "bob", "alice"];
    const pending = users.map(userId => registry.get(controller.id, session.id, { userId }));
    ready.resolve();
    const results = await Promise.allSettled(pending);
    results.forEach((result, index) => {
      if (users[index] === "alice") {
        expect(result.status).toBe("fulfilled");
        if (result.status === "fulfilled") expect(result.value.scope()).toEqual({ userId: "alice" });
      } else {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "NotFound" });
      }
    });
    const restored = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    expect(new Set(restored).size).toBe(1);
  } finally { ready.resolve(); await controller.dispose(); }
});
