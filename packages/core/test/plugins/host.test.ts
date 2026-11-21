import { expect, it } from "vitest";
import { queryObjects } from "node:v8";
import { PluginHost } from "../../src/plugins/host.js";
import type { HookSpec } from "../../src/events/definition.js";
import type { PluginContext } from "../../src/plugins/context.js";

declare module "../../src/events/definition.js" {
  interface EventMap {
    "test.value": HookSpec<string, string>;
    "test.barrier": HookSpec<{}>;
  }
}
it("allows detached plugin capabilities to be garbage collected", async () => {
  class Cache { readonly bytes = new Uint8Array(1024); }
  const host = new PluginHost();
  try {
    for (let index = 0; index < 10; index++) {
      await host.attach({ id: "reloadable", setup(context) {
        context.registry.register("cache", "data", new Cache());
      } });
      await host.detach("reloadable");
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(queryObjects(Cache)).toBe(0);
  } finally { await host.dispose(); }
});

it("reads custom capabilities through the hook context without exposing registry mutation", async () => {
  const host = new PluginHost(),
    memory = { search: () => "remembered" };
  await host.initialize([
    {
      id: "memory",
      setup(tessar) {
        tessar.registry.register("memory", "project", memory);
      },
    },
    {
      id: "consumer",
      setup(tessar) {
        tessar.hook(
          "test.value",
          (_event, context) => {
            expect(context.registry.get("missing", "project")).toBeUndefined();
            expect(context.registry.list("missing")).toEqual([]);
            expect(context.registry.list("memory")).toEqual([memory]);
            expect(Object.keys(context.registry).sort()).toEqual([
              "get",
              "list",
            ]);
            expect(Object.isFrozen(context.registry)).toBe(true);
            return context.registry
              .get<typeof memory>("memory", "project")!
              .search();
          },
          { kind: "transformation" },
        );
      },
    },
  ]);
  try {
    expect(await host.dispatch("test.value", "")).toBe("remembered");
  } finally {
    await host.dispose();
  }
});
it("rolls back setup and retains captured resources until release", async () => {
  const order: string[] = [];
  const host = new PluginHost();
  await host.initialize([
    {
      id: "test",
      setup(tessar) {
        tessar.hook("test.value", (e) => e.payload + "A", {
          kind: "transformation",
        });
        return () => {
          order.push("disposeA");
        };
      },
    },
  ]);
  const captured = host.capture();
  await expect(
    host.attach({
      id: "bad",
      setup(tessar) {
        tessar.hook("test.value", (e) => e.payload + "BAD");
        throw Error("setup");
      },
    }),
  ).rejects.toThrow();
  expect(await host.dispatch("test.value", "")).toBe("A");
  await host.detach("test");
  expect(order).toEqual([]);
  expect(await host.dispatch("test.value", "", {}, captured)).toBe("A");
  expect(await host.dispatch("test.value", "")).toBe("");
  await captured.release();
  expect(order).toEqual(["disposeA"]);
  await host.dispose();
});
it("rejects incompatible hook contracts and plugin IDs and awaits barriers", async () => {
  const host = new PluginHost();
  await expect(host.attach({ id: "", setup() {} })).rejects.toThrow();
  await host.initialize([
    {
      id: "test",
      setup(tessar) {
        tessar.hook(
          "test.barrier",
          async () => {
            throw Error("required");
          },
          { kind: "barrier" },
        );
      },
    },
  ]);
  await expect(host.dispatch("test.barrier", {})).rejects.toThrow("required");
  await expect(
    host.attach({
      id: "foreign",
      setup(tessar) {
        tessar.hook("test.barrier", () => {}, { kind: "barrier", version: 2 });
      },
    }),
  ).rejects.toMatchObject({ code: "RegistrationConflict" });
  await host.dispose();
});
it("disposes resources when shutdown races an asynchronous plugin setup", async () => {
  let release!: () => void,
    entered!: () => void,
    closed = 0;
  const gate = new Promise<void>((r) => (release = r)),
    start = new Promise<void>((r) => (entered = r));
  const host = new PluginHost();
  const installing = host.attach({
    id: "late",
    async setup(tessar) {
      tessar.defer(() => {
        closed++;
      });
      entered();
      await gate;
      tessar.registry.register("capability", "late", {});
    },
  });
  await start;
  const closing = host.dispose();
  release();
  await Promise.allSettled([installing, closing]);
  expect(closed).toBe(1);
  expect(host.registrations()).toHaveLength(0);
});
it("protects shutdown cleanup from notification overrides", async () => {
  const host = new PluginHost();
  await expect(
    host.attach({
      id: "override",
      setup(tessar) {
        tessar.hook("shutdown", () => {}, {
          kind: "notification",
        });
      },
    }),
  ).rejects.toMatchObject({ code: "RegistrationConflict" });
  await host.dispose();
});

it("reserves capability IDs while setup awaits, including against late registrations", async () => {
  const host = new PluginHost();
  let existing!: PluginContext;
  const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  await host.attach({ id: "existing", setup(context) { existing = context; } });
  const attaching = host.attach({
    id: "pending",
    async setup(context) {
      context.registry.register("test", "reserved", "pending");
      enter();
      await gate;
    },
  });
  try {
    await entered;
    expect(() => existing.registry.register("test", "reserved", "late")).toThrowError(expect.objectContaining({ code: "RegistrationConflict" }));
  } finally { release(); await attaching; await host.dispose(); }
});

it("releases capability IDs on rollback and detach without changing captured leases", async () => {
  const host = new PluginHost();
  let stale!: PluginContext;
  await host.attach({ id: "old", setup(context) { stale = context; context.registry.register("test", "shared", "old"); } });
  const captured = host.capture();
  try {
    await host.detach("old");
    await expect(host.attach({ id: "failed", setup(context) {
      context.registry.register("test", "shared", "failed");
      throw Error("setup failed");
    } })).rejects.toThrow("setup failed");
    // A retained context from a detached slot must not reserve live IDs.
    stale.registry.register("test", "detached-only", "ignored");
    await host.attach({ id: "replacement", setup(context) {
      context.registry.register("test", "shared", "new");
      context.registry.register("test", "detached-only", "new");
    } });
    expect(captured.find("test", "shared")).toBe("old");
    expect(host.registrations().map(value => value.value)).toEqual(["new", "new"]);
    await captured.release();
    await expect(host.attach({ id: "duplicate", setup(context) {
      context.registry.register("test", "shared", "conflict");
    } })).rejects.toMatchObject({ code: "RegistrationConflict" });
  } finally { await captured.release(); await host.dispose(); }
});

it("keeps capability kind and ID separate and checks initial capabilities", async () => {
  const host = new PluginHost({ values: [{
    kind: "initial", id: "shared", value: "builtin", version: 1,
    pluginId: "builtin", pluginVersion: 1, configurationId: null,
  }] });
  try {
    await host.attach({ id: "distinct", setup(context) {
      context.registry.register("a:b", "c", 1);
      context.registry.register("a", "b:c", 2);
      context.registry.register("other", "shared", 3);
    } });
    await expect(host.attach({ id: "duplicate", setup(context) {
      context.registry.register("initial", "shared", "conflict");
    } })).rejects.toMatchObject({ code: "RegistrationConflict" });
    expect(host.registrations().map(value => value.value)).toEqual(["builtin", 1, 2, 3]);
  } finally { await host.dispose(); }
});
