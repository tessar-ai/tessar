import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Agent, AssistantMessage, Controller, HumanMessage, MessageCodec, createMemoryBackend } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";

const HISTORY_MESSAGES = 100;
const HISTORY_TEXT_SIZE = 1024;
const WARMUPS = 2;
const SAMPLES = 5;
const REGISTRATION_COUNTS = [100, 1000, 5000];
const PORT_METHODS = {
  threads: ["get"], checkpoints: ["get"], executions: ["get", "listRecords"],
  sessions: ["get", "compareAndSet"], commits: ["stage", "publish"],
};

function createController(plugins = []) {
  return new Controller({
    id: crypto.randomUUID(),
    agent: new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([]) }),
    plugins,
  });
}

async function inspectHydration() {
  const backend = createMemoryBackend();
  const counts = {};
  for (const [port, methods] of Object.entries(PORT_METHODS))
    for (const method of methods) {
      const call = backend[port][method].bind(backend[port]);
      const key = port + "." + method;
      backend[port][method] = async (...args) => { counts[key] = (counts[key] ?? 0) + 1; return call(...args); };
    }
  const controller = createController([{ id: "memory-fixture", setup(context) { context.storage.register(backend); } }]);
  await controller.initialize();
  const messages = Array.from({ length: HISTORY_MESSAGES }, (_, index) => MessageCodec.encode(
    index % 2 === 0
      ? new HumanMessage("h".repeat(HISTORY_TEXT_SIZE), { id: "history-" + index })
      : new AssistantMessage("a".repeat(HISTORY_TEXT_SIZE), { id: "history-" + index }),
  ));
  const session = await controller.createSession();
  const first = await session.thread.create({ messages });
  await session.thread.create({ messages });
  const operations = [];
  const observe = async (name, operation) => {
    for (const key of Object.keys(counts)) delete counts[key];
    const started = performance.now();
    const result = await operation();
    operations.push({ name, elapsedMs: performance.now() - started, calls: { ...counts } });
    return result;
  };
  try {
    const snapshot = await observe("thread.snapshot", () => first.snapshot());
    assert.equal(snapshot.state.messages.length, HISTORY_MESSAGES);
    await observe("session.thread.switch", () => session.thread.switch(first.id));
    assert.equal(session.thread.getId(), first.id);
    const restored = await observe("controller.getSession", () => controller.getSession(session.id));
    assert.ok(restored);
    assert.equal(restored.state.get().messages.length, HISTORY_MESSAGES);
    await observe("session.dispose", () => session.dispose());
    await observe("controller.dispose", () => controller.dispose());
    return operations;
  } finally { await controller.dispose(); await backend.close(); }
}

async function registrations(count) {
  const controller = createController([{
    id: "registrations-fixture",
    setup(context) {
      for (let index = 0; index < count; index++) context.registry.register("fixture", "value-" + index, index);
    },
  }]);
  globalThis.gc?.();
  const started = performance.now();
  try {
    await controller.initialize();
    const elapsedMs = performance.now() - started;
    assert.equal(controller.hooks.registrations().filter(value => value.kind === "fixture").length, count);
    return elapsedMs;
  } finally { await controller.dispose(); }
}

const registrationResults = [];
for (const count of REGISTRATION_COUNTS) {
  for (let iteration = 0; iteration < WARMUPS; iteration++) await registrations(count);
  const samples = [];
  for (let iteration = 0; iteration < SAMPLES; iteration++) samples.push(await registrations(count));
  registrationResults.push({ count, samples, medianMs: [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] });
}
console.log(JSON.stringify({
  node: process.version, platform: process.platform, arch: process.arch,
  hydration: await inspectHydration(), registrations: registrationResults,
}, null, 2));
