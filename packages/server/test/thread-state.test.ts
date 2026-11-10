import { afterEach, expect, test } from "vitest";
import { Agent, Controller, AssistantMessage, MessageCodec, createTool, EventEnvelope, stateChanged, stream, type RuntimeState } from "@tessar/core";
import { z } from "zod";
import { ScriptedProvider } from "@tessar/core/testing";
import { RuntimeRegistry } from "../src/runtime/runtime-registry.js";
import { ObserverPlugin } from "../src/runtime/observer-plugin.js";
import { ThreadStateHub } from "../src/runtime/thread-state-hub.js";

let runtimes: RuntimeRegistry;
afterEach(async () => { await runtimes?.dispose(); });
test("public hooks share admitted Thread state while Session selections and queues remain independent", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const model = new ScriptedProvider([{ text: "shared answer", gate }, { text: "second answer" }]);
  const controller = new Controller({ id: crypto.randomUUID(), agent: new Agent({ id: crypto.randomUUID(), model }) });
  runtimes = new RuntimeRegistry({ controllers: [controller] });
  const hub = new ThreadStateHub();
  await controller.initialize();
  await controller.plugins.attach(new ObserverPlugin(store => runtimes.records.set(controller.id, store), hub));
  expect(runtimes.records.get(controller.id)).toBeDefined();
  const a = await controller.createSession();
  const shared = await a.thread.create();
  const b = await controller.createSession();
  await b.thread.switch(shared.id);
  hub.attach(controller.id, a); hub.attach(controller.id, b);
  const seen: string[] = [];
  const off = hub.subscribe(controller.id, b, event => { seen.push(event.payload.state.status); });
  await a.followUp("hello");
  await expect.poll(() => model.calls.length).toBe(1);
  expect((await hub.getSnapshot(controller.id, b)).status).toBe("running");
  await b.followUp("competing input");
  await expect.poll(() => b.state.get().error?.code).toBe("ThreadBusy");
  expect((await hub.getSnapshot(controller.id, a)).error).toBeNull();
  expect((await hub.getSnapshot(controller.id, b)).error?.code).toBe("ThreadBusy");
  await a.followUp("queued");
  expect((await hub.getSnapshot(controller.id, b)).queuedInputs).toBe(0);
  release();
  await expect.poll(() => a.isIdle()).toBe(true);
  const view = await hub.getSnapshot(controller.id, b);
  expect(JSON.stringify(view.messages)).toContain("shared answer");
  expect(seen).toContain("running");
  expect(b.thread.getId()).toBe(shared.id);
  const other = await b.thread.create();
  expect(other.id).not.toBe(shared.id);
  expect(a.thread.getId()).toBe(shared.id);
  off(); hub.close();
});

test("deletion invalidates the other Session view without choosing another Thread", async () => {
  const controller = new Controller({ id: crypto.randomUUID(), agent: new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([]) }) });
  runtimes = new RuntimeRegistry({ controllers: [controller] });
  const hub = new ThreadStateHub();
  await controller.initialize();
  await controller.plugins.attach(new ObserverPlugin(() => { }, hub));
  const a = await controller.createSession(), b = await controller.createSession();
  const shared = await a.thread.create(); await b.thread.switch(shared.id);
  hub.attach(controller.id, a); hub.attach(controller.id, b);
  const errors: string[] = [];
  hub.subscribe(controller.id, b, event => { if (event.payload.state.error) errors.push(event.payload.state.error.code); });
  await a.thread.delete();
  await expect(hub.getSnapshot(controller.id, b)).rejects.toMatchObject({ code: "ThreadNotFound" });
  expect(errors).toContain("ThreadNotFound");
  expect(b.thread.getId()).toBe(shared.id);
  hub.close();
});

test("old execution frames cannot overwrite the currently admitted Thread", async () => {
  const controller = new Controller({ id: crypto.randomUUID(), agent: new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([]) }) });
  runtimes = new RuntimeRegistry({ controllers: [controller] }); await controller.initialize();
  const session = await controller.createSession(); const selected = await session.thread.create();
  const hub = new ThreadStateHub(); hub.attach(controller.id, session);
  const identity = { controllerId: controller.id, threadId: selected.id, sessionId: session.id };
  const state = { ...session.state.get(), status: "running" } as RuntimeState;
  hub.observe(new EventEnvelope(stream.started, {}, { ...identity, streamId: "new", handleId: "current" }));
  hub.observe(new EventEnvelope(stateChanged, { state }, { ...identity, streamId: "new", handleId: "current" }));
  hub.observe(new EventEnvelope(stateChanged, { state: { ...state, status: "failed" } }, { ...identity, streamId: "old", handleId: "old" }));
  expect((await hub.getSnapshot(controller.id, session)).status).toBe("running");
  hub.close();
});

test("shared Thread viewers receive reasoning and transient tool progress without duplicating tools", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let effects = 0;
  const work = createTool({
    name: "work", description: "work", schema: z.object({}),
    async execute(_, context) { effects++; context.emit({ done: 1 }); await gate; return "tool result"; }
  });
  const model = new ScriptedProvider([{
    response: {
      message: MessageCodec.encode(new AssistantMessage([
        { type: "reasoning", text: "thinking" }, { type: "tool-call", name: "work", toolCallId: "call", arguments: {} },
      ]))
    }
  }, { text: "finished" }]);
  const controller = new Controller({ id: crypto.randomUUID(), agent: new Agent({ id: crypto.randomUUID(), model, tools: { work } }) });
  runtimes = new RuntimeRegistry({ controllers: [controller] }); await controller.initialize();
  const hub = new ThreadStateHub();
  await controller.plugins.attach(new ObserverPlugin(() => { }, hub));
  const a = await controller.createSession(), b = await controller.createSession(), unrelated = await controller.createSession();
  const shared = await a.thread.create(); await b.thread.switch(shared.id); await unrelated.thread.create();
  for (const session of [a, b, unrelated]) hub.attach(controller.id, session);
  await a.followUp("work");
  await expect.poll(() => effects).toBe(1);
  const view = await hub.getSnapshot(controller.id, b);
  expect(JSON.stringify(view.messages)).toContain("thinking");
  expect(view.tools[0]?.progress).toEqual({ done: 1 });
  expect((await hub.getSnapshot(controller.id, unrelated)).tools).toHaveLength(0);
  release(); await expect.poll(() => a.isIdle()).toBe(true);
  expect(effects).toBe(1); expect(model.calls).toHaveLength(2);
  expect(JSON.stringify((await hub.getSnapshot(controller.id, b)).messages)).toContain("finished");
  hub.close();
});
