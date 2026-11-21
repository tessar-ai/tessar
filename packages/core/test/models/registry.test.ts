import { expect, it } from "vitest";
import { queryObjects } from "node:v8";
import { ModelRegistry } from "../../src/models/registry.js";
it("releases provider factories and model handles on shutdown", async () => {
  class Provider { readonly id = "owned"; create(): never { throw Error("unused"); } }
  const registry = new ModelRegistry();
  async function seed() {
    registry.registerProvider(new Provider());
    await registry.get({ providerId: "owned", modelId: "m" }).refreshProfile();
  }
  await seed(); registry.dispose();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(queryObjects(Provider)).toBe(0);
});

it("removes a detached provider's cached and in-flight profiles without clearing a replacement", async () => {
  const registry = new ModelRegistry();
  const gate = Promise.withResolvers<void>();
  try {
    const remove = registry.registerProvider({ id: "reloadable", metadataPartition: "stable",
      create() { throw Error("unused"); }, metadata: { async resolve() { await gate.promise; return { name: "old" }; } },
    });
    const old = registry.get({ providerId: "reloadable", modelId: "m" });
    const pending = old.refreshProfile();
    remove();
    registry.registerProvider({ id: "reloadable", metadataPartition: "stable",
      create() { throw Error("unused"); }, metadata: { async resolve() { return { name: "new" }; } },
    });
    const current = registry.get({ providerId: "reloadable", modelId: "m" });
    const replacement = current.refreshProfile();
    gate.resolve(); await Promise.all([pending, replacement]);
    expect(current.profile().name).toBe("new");
    expect(registry.resolver.cache.size).toBe(1);
  } finally { gate.resolve(); registry.dispose(); }
});

it("does not retain profiles after repeated provider removal", async () => {
  const registry = new ModelRegistry();
  try {
    for (let index = 0; index < 10; index++) {
      const remove = registry.registerProvider({ id: "reloadable", create() { throw Error("unused"); },
        metadata: { async resolve() { return { name: "profile" }; } },
      });
      await registry.get({ providerId: "reloadable", modelId: "m" }).refreshProfile();
      remove();
    }
    expect(registry.resolver.cache.size).toBe(0);
  } finally { registry.dispose(); }
});

it.each([false, true])("isolates profiles for separate connections (concurrent: %s)", async concurrent => {
  const registry = new ModelRegistry();
  const gate = Promise.withResolvers<void>();
  registry.registerProvider({
    id: "custom", create() { throw Error("unused adapter"); },
    metadata: { async resolve(ref) {
      await gate.promise;
      return { contextWindow: ref.connectionId === "a" ? 1000 : 2000 };
    } },
  });
  try {
    const a = registry.get({ providerId: "custom", modelId: "model", connectionId: "a" });
    const first = a.refreshProfile();
    if (!concurrent) { gate.resolve(); await first; }
    const b = registry.get({ providerId: "custom", modelId: "model", connectionId: "b" });
    const second = b.refreshProfile();
    gate.resolve();
    await Promise.all([first, second]);
    expect(a.profile()).toMatchObject({ connectionId: "a", contextWindow: 1000 });
    expect(b.profile()).toMatchObject({ connectionId: "b", contextWindow: 2000 });
  } finally { gate.resolve(); registry.dispose(); }
});

it("forgets retained connections when a provider is detached or replaced", () => {
  const registry = new ModelRegistry();
  const adapter = (endpoint: string): import("../../src/models/contract.js").ModelAdapter => ({
    ref: { providerId: "custom", modelId: "model", connectionId: "named" },
    connection: { providerId: "custom", connectionId: "named", protocol: "test", endpoint },
    validate() {}, async *stream() {},
  });
  try {
    const old = adapter("old"), remove = registry.registerProvider({ id: "custom", create: () => old });
    registry.retain(old);
    expect(() => registry.retain(adapter("different"))).toThrowError(expect.objectContaining({ code: "ModelContextIncompatible" }));
    remove();
    expect(() => registry.resolve(old.ref)).toThrowError(expect.objectContaining({ code: "MissingProvider" }));
    const next = adapter("new");
    registry.registerProvider({ id: "custom", create: () => next });
    expect(registry.resolve(next.ref)).toBe(next);
  } finally { registry.dispose(); }
});
it("resolves metadata automatically while its synchronous getter remains immutable", async () => {
  let calls = 0;
  const registry = new ModelRegistry({
    catalog: {
      revision: "fixture",
      fetchedAt: "2026-10-15T00:00:00Z",
      entries: {},
    },
  });
  registry.registerProvider({
    id: "custom",
    create: () => {
      throw Error("unused adapter");
    },
    metadata: {
      resolve: async () => {
        calls++;
        return { contextWindow: 1234, capabilities: { reasoning: true } };
      },
    },
  });
  const model = registry.get({ providerId: "custom", modelId: "new" }),
    before = model.profile();
  expect(calls).toBe(0);
  expect(before.contextWindow).toBeNull();
  expect(before.capabilities.reasoning).toBeNull();
  await model.refreshProfile();
  expect(calls).toBe(1);
  expect(model.profile().contextWindow).toBe(1234);
  expect(before.contextWindow).toBeNull();
  expect(Object.isFrozen(model.profile().capabilities)).toBe(true);
  registry.dispose();
});
it("marks stale snapshots and automatically refreshes a selected handle after 24 hours", async () => {
  let now = Date.parse("2026-10-15T00:00:00Z"),
    calls = 0;
  const registry = new ModelRegistry({
    clock: { now: () => new Date(now).toISOString() },
  });
  registry.registerProvider({
    id: "ttl",
    create: () => {
      throw Error("unused");
    },
    metadata: { resolve: async () => ({ name: "refresh-" + ++calls }) },
  });
  const ref = { providerId: "ttl", modelId: "custom" },
    model = registry.get(ref);
  await model.refreshProfile();
  now += 24 * 60 * 60 * 1000;
  expect(model.profile().metadata.freshness).toBe("stale");
  expect(registry.get(ref)).toBe(model);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(calls).toBe(2);
  registry.dispose();
});
it("keeps account caches isolated and unknown models available with partial profiles", async () => {
  const one = new ModelRegistry(),
    two = new ModelRegistry();
  one.registerProvider({
    id: "private",
    metadataPartition: "one",
    create: () => {
      throw Error("unused");
    },
    metadata: { resolve: async () => ({ name: "account one" }) },
  });
  two.registerProvider({
    id: "private",
    metadataPartition: "two",
    create: () => {
      throw Error("unused");
    },
    metadata: { resolve: async () => ({ name: "account two" }) },
  });
  const a = one.get({ providerId: "private", modelId: "custom" }),
    b = two.get({ providerId: "private", modelId: "custom" });
  await Promise.all([a.refreshProfile(), b.refreshProfile()]);
  expect(a.profile().name).toBe("account one");
  expect(b.profile().name).toBe("account two");
  expect(() => one.get({ providerId: "absent", modelId: "x" })).toThrow();
  one.dispose();
  two.dispose();
});
