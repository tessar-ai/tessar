import { text } from "../../src/events/type.js";
import { message as messageHooks } from "../../src/events/type.js";
import { it } from "vitest";

import type { PluginContext } from "../../src/plugins/context.js";
import { defineInterruption } from "../../src/engine/interrupt.js";
it("does not offer suspend on notification hooks", () => {
  const check = (tessar: PluginContext) => {
    const retry = defineInterruption({ id: "retry", version: 1, response: { jsonSchema: {}, parse: (value: unknown) => value }, resolve: () => ({ decision: "retry" as const }) });
    if (false) {
      // @ts-expect-error Tool policy cannot select a model
      tessar.hook("tool.before", () => ({ decision: "select", model: { providerId: "p", modelId: "m" } }));
      // @ts-expect-error Model selection cannot request a retry
      tessar.hook("model.select", () => ({ decision: "retry" }));
      // @ts-expect-error Turn decisions cannot fail an unrelated operation
      tessar.hook("turn.decision", () => ({ decision: "fail" }));
    }
    tessar.hook("tool.before", (_event, context) => {
      if (false) {
        // @ts-expect-error A tool approval cannot resolve to a model retry
        context.suspend(retry, {});
        // @ts-expect-error Checkpoint serialization is internal
        context.state.snapshots();
        // @ts-expect-error Changing the owner does not expose serialization
        context.state.withOwner({ type: "turn", id: "turn" }).snapshots();
      }
    });
    tessar.hook("model.recover", (_event, context) => context.suspend(retry, {}));
    tessar.hook(text.delta, (_event, context) => {
      // @ts-expect-error notifications cannot suspend the engine
      context.suspend({}, {});
    });
  };
  void check;
});
