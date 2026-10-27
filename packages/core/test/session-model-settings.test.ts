import { expect, it } from "vitest";
import {
  Agent,
  Controller,
  type ModelAdapter,
  type JsonObject,
} from "../src/index.js";
import { ScriptedProvider } from "../src/testing/scripted-provider.js";

it("persists current model options before separate option/model notifications and maps effort through the adapter", async () => {
  const scripted = new ScriptedProvider([{ text: "answer" }]);
  const connection = (modelId: string): ModelAdapter => ({
    ...scripted.withModel(modelId),
    options: { temperature: 0.2 },
    effortOptions(level, options) {
      return { ...options, custom_effort: level };
    },
  });
  const agent = new Agent({
    id: crypto.randomUUID(),
    model: { providerId: "scripted", modelId: "test" },
  });
  const controller = new Controller({
    id: crypto.randomUUID(),
    agent,
    plugins: [
      {
        id: "models",
        setup(tessar) {
          tessar.models.register({ id: "scripted", create: connection });
        },
      },
    ],
  });
  await controller.initialize();
  try {
    const session = await controller.createSession();
    const events: string[] = [];
    session.subscribe((event) => {
      if (
        event.type === "session.model-changed" ||
        event.type === "session.model.options-changed"
      ) {
        events.push(event.type);
        expect(session.model.info().options).toEqual(event.payload.options);
      }
    });
    expect(session.model.info()).toMatchObject({
      id: "scripted/test",
      name: "test",
      options: { temperature: 0.2 },
    });
    await session.model.switch("test", { temperature: 0.6 });
    await session.model.setEffort("high");
    expect(session.model.info().options).toEqual({
      temperature: 0.6,
      custom_effort: "high",
    });
    const restored = await controller.getSession(session.id);
    expect(restored!.model.info()).toEqual(session.model.info());
    const options = session.model.info().options as JsonObject;
    await session.model.switch("test", options);
    expect(events).toEqual([
      "session.model.options-changed",
      "session.model.options-changed",
    ]);
    await session.model.switch("next");
    expect(events).toContain("session.model-changed");
    expect(Object.isFrozen(session.model.info())).toBe(true);
  } finally {
    await controller.dispose();
  }
});
