import { afterEach, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { Agent, Controller, TessarError, createMemoryBackend, defineInterruption, ToolDecision, stream, stateChanged, type EventEnvelope } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { ObserverPlugin } from "../src/runtime/observer-plugin.js";
import { ThreadStateHub } from "../src/runtime/thread-state-hub.js";
import { start } from "./helpers.js";

let controller: Controller;
afterEach(async () => { await controller?.dispose(); });

test.each([false, true])("direct Agent resume updates shared Session state (delayed snapshots: %s)", async delayed => {
  const pending: { event: EventEnvelope; release: () => void }[] = [];
  let first = true;
  const approval = defineInterruption({
    id: "approve", version: 1,
    response: { jsonSchema: { type: "boolean" }, parse: value => value }, resolve: () => ToolDecision.allow()
  });
  const agent = new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([{ text: "direct answer" }]) });
  controller = new Controller({
    id: crypto.randomUUID(), agent,
    plugins: [{
      id: "approval", setup(context) {
        context.interruptions.register(approval);
        context.hook(stream.before, (_, execution) => { if (first) { first = false; return execution.suspend(approval, {}); } });
        context.hook(stateChanged, event => {
          if (delayed && event.handleId) return new Promise<void>(release => pending.push({ event, release }));
        });
      }
    }]
  });
  const hub = new ThreadStateHub();
  await controller.initialize();
  await controller.plugins.attach(new ObserverPlugin(() => { }, hub));
  try {
    const initial = await agent.generate("question");
    const viewer = await controller.createSession();
    await viewer.thread.switch(initial.threadId!); hub.attach(controller.id, viewer);
    const oldHandle = pending[0]?.event.handleId;
    let status: string | undefined;
    for await (const event of agent.resume({ threadId: initial.threadId!, interruptId: initial.interrupt!.id, value: true }))
      if (event.type === stream.end) status = event.payload.status;
    expect(status).toBe("completed");
    for (const item of pending.filter(item => item.event.handleId === oldHandle)) item.release();
    await new Promise(resolve => setImmediate(resolve));
    for (const item of pending.filter(item => item.event.handleId !== oldHandle)) item.release();
    await expect.poll(async () => (await hub.getSnapshot(controller.id, viewer)).status).toBe("completed");
    expect(JSON.stringify((await hub.getSnapshot(controller.id, viewer)).messages)).toContain("direct answer");
  } finally { for (const item of pending) item.release(); hub.close(); }
});

test("delayed snapshots from before resume cannot replace the resumed Session state", async () => {
  const pending: { event: EventEnvelope; release: () => void }[] = [];
  let first = true;
  const approval = defineInterruption({
    id: "approve", version: 1,
    response: { jsonSchema: { type: "boolean" }, parse: value => value }, resolve: () => ToolDecision.allow()
  });
  controller = new Controller({
    id: crypto.randomUUID(), agent: new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([{ text: "done" }]) }),
    plugins: [{
      id: "delayed-observer", setup(context) {
        context.interruptions.register(approval);
        context.hook(stream.before, (_, execution) => { if (first) { first = false; return execution.suspend(approval, {}); } });
        context.hook(stateChanged, event => {
          if (event.handleId) return new Promise<void>(release => pending.push({ event, release }));
        });
      }
    }]
  });
  const hub = new ThreadStateHub();
  await controller.initialize();
  await controller.plugins.attach(new ObserverPlugin(() => { }, hub));
  const a = await controller.createSession(), b = await controller.createSession();
  const thread = await a.thread.create(); await b.thread.switch(thread.id);
  hub.attach(controller.id, b);
  try {
    await a.followUp("test");
    await expect.poll(() => a.state.get().status).toBe("suspended");
    const oldHandle = pending[0]!.event.handleId;
    await a.resume({ interruptId: a.state.get().interrupt!.id, value: true });
    await expect.poll(() => a.state.get().status).toBe("completed");
    for (const item of pending.filter(item => item.event.handleId === oldHandle)) item.release();
    await new Promise(resolve => setImmediate(resolve));
    for (const item of pending.filter(item => item.event.handleId !== oldHandle)) item.release();
    await new Promise(resolve => setImmediate(resolve));
    expect((await hub.getSnapshot(controller.id, b)).status).toBe("completed");
    expect(JSON.stringify((await hub.getSnapshot(controller.id, b)).messages)).toContain("done");
  } finally { for (const item of pending) item.release(); hub.close(); }
});

test("Agent HTTP resume shares the new handle even when plugin snapshots arrive late", async () => {
  const pending: { event: EventEnvelope; release: () => void }[] = [];
  let first = true;
  const approval = defineInterruption({
    id: "approve", version: 1,
    response: { jsonSchema: { type: "boolean" }, parse: value => value }, resolve: () => ToolDecision.allow()
  });
  const model = new ScriptedProvider([{ text: "resumed answer" }]);
  controller = new Controller({
    id: crypto.randomUUID(), agent: new Agent({ id: crypto.randomUUID(), model }),
    plugins: [{
      id: "delay", setup(context) {
        context.interruptions.register(approval);
        context.hook(stream.before, (_, execution) => { if (first) { first = false; return execution.suspend(approval, {}); } });
        context.hook(stateChanged, event => {
          if (event.handleId) return new Promise<void>(release => pending.push({ event, release }));
        });
      }
    }]
  });
  const host = await start({ agents: [], controllers: [controller] });
  const agentPath = `/api/agents/${controller.agent.id}`;
  const frames = (text: string) => text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  const postStream = async (path: string, body: unknown) => (await fetch(host.url + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })).text();
  try {
    const suspended = frames(await postStream(agentPath + "/stream", { input: "question" })).at(-1)!;
    expect(suspended.payload.state.status).toBe("suspended");
    const oldHandle = pending[0]!.event.handleId;
    const c = `/api/controllers/${controller.id}`;
    const { data: session } = await host.request(c + "/sessions", "POST", {});
    const s = c + "/sessions/" + session.id;
    await host.request(s + "/thread/switch", "POST", { threadId: suspended.threadId });
    const resumed = frames(await postStream(agentPath + "/resume", {
      threadId: suspended.threadId, interruptId: suspended.payload.state.interrupt.id, value: true,
    })).at(-1)!;
    expect(resumed.payload.state.status).toBe("completed");
    for (const item of pending.filter(item => item.event.handleId === oldHandle)) item.release();
    await new Promise(resolve => setImmediate(resolve));
    for (const item of pending.filter(item => item.event.handleId !== oldHandle)) item.release();
    await new Promise(resolve => setImmediate(resolve));
    const state = (await host.request(s + "/state")).data;
    expect(state.status).toBe("completed");
    expect(JSON.stringify(state.messages)).toContain("resumed answer");
    expect(model.calls).toHaveLength(1);
  } finally { for (const item of pending) item.release(); await host.server.shutdown(); }
});

test("storage failure releases an execution view after its last Session closes", async () => {
  const backend = createMemoryBackend();
  const publish = backend.commits.publish.bind(backend.commits);
  let broken = false;
  backend.commits.publish = async request => {
    if (broken) throw new TessarError("StorageUnavailable", "simulated storage fault", { source: "storage" });
    return publish(request);
  };
  const provider = new ScriptedProvider([{ text: "answer" }]);
  const generate = provider.stream.bind(provider);
  provider.stream = (...args) => { broken = true; return generate(...args); };
  controller = new Controller({
    id: crypto.randomUUID(), agent: new Agent({ id: crypto.randomUUID(), model: provider }),
    plugins: [{ id: "storage", setup(context) { context.storage.register(backend); } }]
  });
  const hub = new ThreadStateHub();
  await controller.initialize();
  await controller.plugins.attach(new ObserverPlugin(() => { }, hub));
  const session = await controller.createSession(); await session.thread.create(); hub.attach(controller.id, session);
  try {
    await session.followUp("test");
    await expect.poll(() => session.state.get().error?.code).toBe("StorageUnavailable");
    await expect.poll(() => session.isIdle()).toBe(true);
    await session.dispose(); hub.remove(session);
    // Inspect retention without adding a production-only diagnostic method.
    const retained = (hub as unknown as { threads: Map<string, unknown> }).threads;
    expect(retained.size).toBe(0);
  } finally { broken = false; hub.close(); await controller.dispose(); await backend.close(); }
});

test("binding a raw admission preserves a competing Session error raised after the hook admission", async () => {
  const admitted = Promise.withResolvers<void>();
  const lifecycle = Promise.withResolvers<void>();
  const modelGate = Promise.withResolvers<void>();
  const provider = new ScriptedProvider([{ text: "answer", gate: modelGate.promise }]);
  controller = new Controller({ id: crypto.randomUUID(), agent: new Agent({ id: crypto.randomUUID(), model: provider }) });
  const hub = new ThreadStateHub();
  await controller.initialize();
  await controller.plugins.attach(new ObserverPlugin(() => { }, hub));
  await controller.plugins.attach({
    id: "hold-admission", setup(context) {
      context.hook(stream.started, async () => { admitted.resolve(); await lifecycle.promise; });
    }
  });
  const a = await controller.createSession(), b = await controller.createSession();
  const selected = await a.thread.create(); await b.thread.switch(selected.id);
  hub.attach(controller.id, b);
  try {
    await a.followUp("first"); await admitted.promise;
    await b.followUp("competing");
    await expect.poll(() => b.state.get().error?.code).toBe("ThreadBusy");
    lifecycle.resolve();
    await expect.poll(() => provider.calls.length).toBe(1);
    expect((await hub.getSnapshot(controller.id, b)).status).toBe("running");
    expect((await hub.getSnapshot(controller.id, b)).error?.code).toBe("ThreadBusy");
  } finally {
    lifecycle.resolve(); modelGate.resolve();
    await expect.poll(() => a.isIdle()).toBe(true);
    hub.close();
  }
});

test("the README streaming example propagates a failed stream.end outcome", async () => {
  const readme = await readFile(new URL("../../../README.md", import.meta.url), "utf8");
  const snippet = readme.match(/```ts\r?\n(import \{ text, stream \}[\s\S]*?)```/)![1]!;
  const body = snippet.replace(/^import .*;\r?\n/m, "");
  const run = new Function("agent", "text", "stream", `return (async () => { ${body} })();`);
  const core = await import("@tessar/core");
  const agent = new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([{ error: new Error("provider failed") }]) });
  try { await expect(run(agent, core.text, core.stream)).rejects.toThrow("provider failed"); }
  finally { await agent.shutdown(); }
});
