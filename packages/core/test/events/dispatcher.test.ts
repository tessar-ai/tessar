import { expect, it } from "vitest";
import { EventEnvelope, type HookSpec } from "../../src/events/definition.js";
import { PluginHost } from "../../src/plugins/host.js";
declare module "../../src/events/definition.js" {
  interface EventMap {
    "test.transform": HookSpec<string, string>;
    "test.decide": HookSpec<{}, { decision: "allow" | "deny" }>;
    "test.notice": HookSpec<string>;
  }
}
const Transform = "test.transform",
  Decide = "test.decide",
  Notice = "test.notice";
it("exports identity metadata without leaking runtime capabilities", () => {
  const event = new EventEnvelope(Notice, "hello", {
    threadId: "t",
    state: { secret: true },
    effects: { execute: () => {} },
  } as never);
  expect(event.type).toBe(Notice);
  expect(event.threadId).toBe("t");
  expect(Object.hasOwn(event, "state")).toBe(false);
  expect(Object.hasOwn(event, "effects")).toBe(false);
});
it("chains transformations and never overturns a denial", async () => {
  const host = new PluginHost();
  await host.initialize([
    {
      id: "test",
      setup(tessar) {
        tessar.hook(Transform, (e) => e.payload + "A", {
          kind: "transformation",
        });
        tessar.hook(Transform, (e) => e.payload + "B");
        tessar.hook(Decide, () => ({ decision: "deny" }), { kind: "decision" });
        tessar.hook(Decide, () => ({ decision: "allow" }));
      },
    },
  ]);
  expect(await host.dispatch(Transform, "x")).toBe("xAB");
  expect(await host.dispatch(Decide, {})).toEqual({ decision: "deny" });
  await host.dispose();
});
it("looks hooks up by string and isolates observer errors", async () => {
  const diagnostics: string[] = [];
  const host = new PluginHost({
    diagnostics: (e) => diagnostics.push(e.source + ":" + e.pluginId),
  });
  await host.initialize([
    {
      id: "test",
      setup(tessar) {
        tessar.hook(Notice, () => {
          throw Error("observer");
        });
      },
    },
  ]);
  await expect(host.dispatch("test.notice", "x")).resolves.toBeUndefined();
  expect(diagnostics).toEqual(["plugin:test"]);
  expect(new EventEnvelope(Notice, "hello").type).toBe(Notice);
  await host.dispose();
});
it("continues handlers in saved manifest order after plugin reordering", async () => {
  const seen: string[] = [];
  const host = new PluginHost();
  for (const id of ["b", "a"])
    await host.attach({
      id,
      setup(tessar) {
        tessar.hook(
          Decide,
          () => {
            seen.push(id);
            return { decision: "allow" };
          },
          { kind: "decision" },
        );
      },
    });
  await host.dispatch(
    Decide,
    {},
    {
      allowedHandlerIds: ["a:test.decide:0", "b:test.decide:0"],
      startIndex: 1,
    },
  );
  expect(seen).toEqual(["b"]);
  await host.dispose();
});
