import { expect, it } from "vitest";
import { Agent, Controller, ready, type PluginContext } from "../../src/index.js";
import { ScriptedProvider } from "../../src/testing/scripted-provider.js";

it("exposes the selected record backend to plugins after readiness without an execution", async () => {
  let storage!: PluginContext["storage"];
  const controller = new Controller({
    id: "records-controller",
    agent: new Agent({ id: "records-agent", model: new ScriptedProvider([]) }),
    plugins: [{
      id: "records-consumer",
      async setup(tessar) {
        storage = tessar.storage;
        await expect(storage.records.append({ namespace: "audit", data: "too early" })).rejects.toMatchObject({ code: "ControllerNotReady" });
        tessar.hook(ready, async () => {
          await storage.records.append({ namespace: "audit", id: "ready", data: { ready: true } });
        });
      },
    }],
  });
  try {
    await controller.initialize();
    expect((await storage.records.get("audit", "ready"))?.data).toEqual({ ready: true });
    expect((await storage.records.list({ namespace: "audit" })).items).toHaveLength(1);
    expect((await controller.listSessions()).items).toEqual([]);
  } finally { await controller.dispose(); }
  await expect(storage.records.list({ namespace: "audit" })).rejects.toMatchObject({ code: "ControllerNotReady" });
});
