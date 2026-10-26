import {
  tool as toolHooks,
  stream as streamHooks,
} from "../../src/events/type.js";
import { expect, it } from "vitest";

import { PluginHost } from "../../src/plugins/host.js";
import type { Plugin } from "../../src/plugins/context.js";
import { AgentHarness } from "../../src/testing/harness.js";
import { setTimeout as delay } from "node:timers/promises";

it("timestamps a notification once before delivering it to multiple hooks", async () => {
  const seen: string[] = [];
  const h = await AgentHarness.create({ plugins: [{ id: "clock", setup(tessar) {
    tessar.hook("ready", async (event) => { seen.push(event.timestamp!); await delay(10); });
    tessar.hook("ready", (event) => { seen.push(event.timestamp!); });
    tessar.hook("thread.started", (event) => { seen.push(event.timestamp!); });
  } }] });
  try {
    await h.controller.createSession({ threadId: "clock-thread" });
    expect(seen.every((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))).toBe(true);
    expect(seen[0]).toBe(seen[1]);
  } finally { await h.dispose(); }
});

it("delivers an admission error with matching identity and timestamp to hooks and iterator", async () => {
  const errors: { timestamp?: string; streamId?: string | null; code: string }[] = [];
  const h = await AgentHarness.create({ modelScripts: [{ text: "ok" }], plugins: [{ id: "errors", setup(tessar) {
    tessar.hook("stream.error", (event) => { errors.push({ timestamp: event.timestamp, streamId: event.streamId, code: event.payload.error.code }); });
  } }] });
  try {
    await h.collect(h.agent.stream("one", { id: "fixed" }));
    await delay(10);
    const stream = h.agent.stream("two", { id: "fixed" });
    const seen = [];
    for await (const event of stream) if (event.type === "stream.error") seen.push(event);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ timestamp: seen[0]!.timestamp, streamId: "fixed", code: "RegistrationConflict" });
  } finally { await h.dispose(); }
});
it("uses string constants and a version-free plugin with tessar.hook", async () => {
  expect(toolHooks.before).toBe("tool.before");
  const seen: string[] = [];
  const plugin: Plugin = {
    id: "plain",
    setup(tessar) {
      tessar.hook(streamHooks.started, (event) => {
        seen.push(event.type);
      });
    },
  };
  const host = new PluginHost();
  await host.initialize([plugin]);
  await host.dispatch(streamHooks.started, {
    modelRef: { providerId: "p", modelId: "m" },
    checkpointId: "c",
  });
  expect(seen).toEqual(["stream.started"]);
  await host.dispose();
});
