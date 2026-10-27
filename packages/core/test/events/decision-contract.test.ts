import { expect, it } from "vitest";
import { PluginHost } from "../../src/plugins/host.js";
import type { AnyEvent } from "../../src/events/definition.js";

it.each([
  ["stream.before", "retry"],
  ["tool.before", "select"],
  ["turn.decision", "retry"],
  ["model.select", "deny"],
  ["model.recover", "continue"],
  ["tool.before", "fail"],
] as const)(
  "rejects %s returning another boundary's decision %s",
  async (event, decision) => {
    const host = new PluginHost();
    let recorded = false;
    await host.attach({
      id: "invalid",
      setup(tessar) {
        tessar.hook(event, (() => ({ decision })) as any);
      },
    });
    try {
      await expect(
        host.dispatch(event, {} as any, {
          onDecision: async () => {
            recorded = true;
          },
        }),
      ).rejects.toMatchObject({ code: "InvalidHookResult" });
      expect(recorded).toBe(false);
    } finally {
      await host.dispose();
    }
  },
);

it.each([
  "fail",
  null,
  "allow",
  { decision: "allow", reason: false },
  { decision: "select", model: {} },
])("rejects malformed built-in decisions: %j", async (value) => {
  const host = new PluginHost();
  const event: AnyEvent = "model.select";
  await host.attach({
    id: "invalid",
    setup(tessar) {
      tessar.hook(event, (() => value) as any);
    },
  });
  try {
    await expect(host.dispatch(event, {} as any)).rejects.toMatchObject({
      code: "InvalidHookResult",
    });
  } finally {
    await host.dispose();
  }
});
