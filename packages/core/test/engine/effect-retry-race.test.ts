import { expect, it } from "vitest";
import { z } from "zod";
import { EffectService, defineEffect } from "../../src/engine/tracked-effects.js";
import { definePluginState, PluginStateAccess } from "../../src/state/plugin-state.js";
import { TessarError } from "../../src/errors.js";

it("serializes waiting calls through same-key effect recovery", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  let reconciliations = 0;
  const definition = defineEffect({
    id: "charge", version: 1,
    input: { jsonSchema: {}, parse: value => z.object({}).parse(value) },
    output: { jsonSchema: {}, parse: value => z.number().parse(value) },
    execute: async () => {
      calls++;
      if (calls === 1) {
        started.resolve();
        await release.promise;
        throw new TessarError("RecoveryRequired", "Unknown outcome");
      }
      return calls;
    },
    reconcile: async () => { reconciliations++; return { status: "safeToRetry" as const }; },
  });
  const stateDefinition = definePluginState({ pluginId: "test", namespace: "effects", schemaVersion: 1, initial: {} });
  const state = new PluginStateAccess([stateDefinition], { type: "stream", id: "s" });
  const service = new EffectService(
    () => ({ definition, pluginId: "test", stateDefinition }), state, async () => { },
    { signal: new AbortController().signal, threadId: "t", streamId: "s", turnId: null },
    () => crypto.randomUUID(), new Map(),
  );
  const first = service.execute(definition, {}, { key: "same" });
  const failed = expect(first).rejects.toMatchObject({ code: "RecoveryRequired" });
  await started.promise;
  const second = service.execute(definition, {}, { key: "same" });
  const third = service.execute(definition, {}, { key: "same" });
  release.resolve();
  await failed;
  expect(await Promise.all([second, third])).toEqual([2, 2]);
  expect(calls).toBe(2);
  expect(reconciliations).toBe(1);
});

it("snapshots the effect key and parsed input before queuing", async () => {
  const input = { amount: 1 };
  const options = { key: "original" };
  let observed: unknown;
  const definition = defineEffect({
    id: "charge", version: 1,
    input: { jsonSchema: {}, parse: value => value as typeof input },
    output: { jsonSchema: {}, parse: value => z.number().parse(value) },
    execute: async (value, context) => { observed = { amount: value.amount, key: context.key }; return value.amount; },
  });
  const stateDefinition = definePluginState({ pluginId: "test", namespace: "effects", schemaVersion: 1, initial: {} });
  const service = new EffectService(
    () => ({ definition, pluginId: "test", stateDefinition }),
    new PluginStateAccess([stateDefinition], { type: "stream", id: "s" }), async () => { },
    { signal: new AbortController().signal, threadId: "t", streamId: "s", turnId: null },
    () => crypto.randomUUID(), new Map(),
  );
  const pending = service.execute(definition, input, options);
  input.amount = 9;
  options.key = "changed";
  expect(await pending).toBe(1);
  expect(observed).toEqual({ amount: 1, key: "original" });
});
