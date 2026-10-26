import { expect, it, vi } from "vitest";
import {
  Agent,
  Controller,
  createMemoryBackend,
  type Plugin,
} from "../src/index.js";
import { AgentHarness } from "../src/testing/harness.js";
import { ModelRegistry } from "../src/models/registry.js";

it("refreshes the catalog for mapped providers without a metadata resolver", async () => {
  const refresh = vi.spyOn(ModelRegistry.prototype, "refreshCatalog")
    .mockResolvedValue(undefined);
  try {
    const h = await AgentHarness.create({ plugins: [{
      id: "catalog-only",
      setup(tessar) {
        tessar.models.register({
          id: "catalog-only",
          create() { throw Error("catalog reads must not create adapters"); },
          catalogModelRef: (ref) => ref,
          catalogMappingVersion: 1,
        });
      },
    }] });
    try { expect(refresh).toHaveBeenCalledOnce(); }
    finally { await h.dispose(); }
  } finally { refresh.mockRestore(); }
});

it("closes live Session handles before disposing plugins and permits repeated Session disposal", async () => {
  const seen: string[] = [];
  const h = await AgentHarness.create({ plugins: [{ id: "lifecycle", setup(tessar) {
    tessar.hook("session.closed", () => { seen.push("session.closed"); });
    tessar.defer(() => { seen.push("plugin.disposed"); });
  } }] });
  const session = await h.controller.createSession();
  session.subscribe("session.closed", () => { seen.push("subscriber.closed"); });
  await h.dispose();
  expect(session.isDisposed()).toBe(true);
  expect(session.state.get().status).toBe("closed");
  expect(session.followUp.count()).toBe(0);
  await expect(session.dispose()).resolves.toBeUndefined();
  expect(seen).toEqual(["subscriber.closed", "session.closed", "plugin.disposed"]);
});
it("requires explicit IDs and binds an Agent to exactly one Controller", async () => {
  expect(
    () => new Agent({ id: "", model: { providerId: "test", modelId: "test" } }),
  ).toThrow();
  const agent = new Agent({
    id: "a",
    model: { providerId: "test", modelId: "test" },
  });
  expect(() => new Controller({ id: "", agent })).toThrow();
  const controller = new Controller({ id: "r", agent });
  try {
    expect(() => new Controller({ id: "other", agent })).toThrow();
  } finally {
    await controller.dispose();
  }
});
it("initializes once and rolls back failed setup in reverse order", async () => {
  const log: string[] = [];
  const plugin = (id: string): Plugin => ({
    id,
    setup(tessar) {
      log.push(id);
      tessar.defer(() => {
        log.push("close:" + id);
      });
    },
  });
  const plugins = [plugin("a"), plugin("b")];
  const controller = new Controller({
    id: "r",
    agent: new Agent({
      id: "a",
      model: { providerId: "test", modelId: "test" },
    }),
    plugins,
  });
  plugins.push(plugin("not-initial"));
  const one = controller.initialize(),
    two = controller.initialize();
  expect(one).toBe(two);
  await Promise.all([one, two]);
  expect(log).toEqual(["a", "b"]);
  await controller.dispose();
  await controller.dispose();
  expect(log).toEqual(["a", "b", "close:b", "close:a"]);
  const broken = new Controller({
    id: "r",
    agent: new Agent({
      id: "a",
      model: { providerId: "test", modelId: "test" },
    }),
    plugins: [
      plugin("c"),
      {
        id: "bad",
        setup() {
          throw Error("setup");
        },
      },
    ],
  });
  await expect(broken.initialize()).rejects.toThrow("setup");
  expect(log.at(-1)).toBe("close:c");
  await expect(broken.initialize()).rejects.toThrow();
  await broken.dispose();
});
it("rejects conflicting backends and backend attachment after initialization", async () => {
  const storage = (id: string): Plugin => ({
    id,
    setup(tessar) {
      tessar.storage.register(createMemoryBackend());
    },
  });
  const broken = new Controller({
    id: "r",
    agent: new Agent({
      id: "a",
      model: { providerId: "test", modelId: "test" },
    }),
    plugins: [storage("one"), storage("two")],
  });
  await expect(broken.initialize()).rejects.toMatchObject({
    code: "RegistrationConflict",
  });
  await broken.dispose();
  const ready = new Controller({
    id: "r",
    agent: new Agent({
      id: "a",
      model: { providerId: "test", modelId: "test" },
    }),
  });
  await ready.initialize();
  await expect(ready.plugins.attach(storage("late"))).rejects.toMatchObject({
    code: "InvalidTransition",
  });
  await ready.dispose();
});
it("rejects initialization once disposal has started, including before first initialize", async () => {
  const ready = new Controller({
    id: "r",
    agent: new Agent({
      id: "a",
      model: { providerId: "test", modelId: "test" },
    }),
  });
  await ready.initialize();
  const closing = ready.dispose();
  await expect(ready.initialize()).rejects.toMatchObject({ code: "Disposed" });
  await expect(ready.createSession()).rejects.toMatchObject({
    code: "Disposed",
  });
  await closing;
  await expect(ready.initialize()).rejects.toMatchObject({ code: "Disposed" });
  const unused = new Controller({
    id: "unused",
    agent: new Agent({
      id: "unused",
      model: { providerId: "test", modelId: "test" },
    }),
  });
  await unused.dispose();
  await expect(unused.initialize()).rejects.toMatchObject({ code: "Disposed" });
});
