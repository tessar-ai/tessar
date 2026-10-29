import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bounded = (promise, ms = 150) => Promise.race([promise, sleep(ms).then(() => ({ status: "pending" }))]);

if (isMainThread) {
  const hooks = ["thread.prepare", "thread.started", "input.prepare", "message.prepare", "message.before-commit", "checkpoint.committed", "thread.updated", "stream.started", "input.received", "stream.before", "turn.start", "model.select", "tools.select", "context.prepare", "model.request", "model.start", "message.delta", "model.usage", "model.response", "message.committed", "model.end", "turn.end", "turn.decision", "tool.before", "tool.prepare", "tool.start", "tool.result", "tool.end", "stream.before-end", "stream.end"];
  const cases = hooks.map((hook) => ({ name: hook, hook, tool: hook.startsWith("tool."), target: "stream" }));
  cases.push(
    { name: "message.prepare-assistant", hook: "message.prepare", assistantOnly: true },
    { name: "message.beforeCommit-assistant", hook: "message.before-commit", assistantOnly: true },
    { name: "checkpoint.committed-after-admission", hook: "checkpoint.committed", afterAdmission: true },
    { name: "thread.updated-after-admission", hook: "thread.updated", afterAdmission: true },
    { name: "session.threadCreated-await", hook: "session.thread-created", target: "thread" },
    { name: "session.threadCreated-timer", hook: "session.thread-created", target: "thread", timer: true },
    { name: "input.prepare-fire-and-return-timer", hook: "input.prepare", timer: true },
    { name: "external-during-input.prepare", hook: "input.prepare", pauseOnly: true, external: true },
    { name: "external-during-thread.prepare", hook: "thread.prepare", pauseOnly: true, external: true },
    { name: "external-during-model", external: true },
    { name: "external-during-tool", external: true, tool: true },
    { name: "tool.execute-await", toolExecute: true, tool: true },
    { name: "input.prepare-thread-target", hook: "input.prepare", target: "thread" },
    { name: "stream.beforeEnd-thread-target", hook: "stream.before-end", target: "thread" },
    { name: "input.prepare-transient", hook: "input.prepare", persist: false },
    { name: "thread.prepare-transient", hook: "thread.prepare", persist: false },
  );
  const rows = [];
  for (const config of cases) {
    const result = await new Promise((resolve) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: config });
      const timer = setTimeout(() => { void worker.terminate(); resolve({ name: config.name, fatal: "worker timeout" }); }, 3500);
      worker.once("message", (result) => { clearTimeout(timer); void worker.terminate(); resolve(result); });
      worker.once("error", (error) => { clearTimeout(timer); resolve({ name: config.name, fatal: error.stack }); });
    });
    rows.push(result);
    console.log(JSON.stringify(result));
  }
  await writeFile(new URL("repaired-results.json", import.meta.url), JSON.stringify(rows, null, 2));
  const cycles = new Set();
  const rejected = new Map([
    ...["stream.before-end", "stream.end"].map((name) => [name, "AlreadyTerminal"]),
  ]);
  for (const row of rows) {
    assert.equal(row.fatal, undefined, row.name + ": " + row.fatal);
    assert.equal(row.completion.status, "completed", row.name);
    if (cycles.has(row.name)) {
      assert.equal(row.before.status, "pending", row.name);
      assert.equal(row.callsBefore, 0, row.name);
      assert.equal(row.traceBefore.includes("hook-returned"), false, row.name);
      assert.equal(row.after.status, "fulfilled", row.name);
    } else if (rejected.has(row.name)) {
      assert.equal(row.before.status, "rejected", row.name);
      assert.equal(row.before.code, rejected.get(row.name), row.name);
    } else assert.equal(row.before.status, "fulfilled", row.name);
  }
  console.log(JSON.stringify({ checked: rows.length, pendingReceipts: rows.filter((row) => row.before.status === "pending").length, note: "Repaired memory-receipt contract; closed Stream rejection retained" }));
} else {
  try {
    const { Agent, Controller, HumanMessage, AssistantMessage, MessageCodec, createTool } = await import("@tessar/core");
    const { ScriptedProvider } = await import("@tessar/core/testing");
    const { PluginManager } = await import("@tessar/plugins");
    const { z } = await import("zod");
    let releaseModel, toolStarted;
    const modelGate = new Promise((done) => { releaseModel = done; });
    const toolGate = new Promise((done) => { toolStarted = done; });
    let plugin;
    const tool = createTool({ name: "work", description: "probe", schema: z.object({}), execute: async () => {
      toolStarted();
      if (workerData.toolExecute) { plugin.trace.push("tool-execute-entered"); plugin.entered.resolve(); await plugin.notify(); }
      if (workerData.external) await modelGate;
      return "tool finished";
    } });
    const scripts = workerData.tool
      ? [{ response: { message: MessageCodec.encode(new AssistantMessage([{ type: "tool-call", name: "work", toolCallId: "c1", arguments: {} }])) } }, { text: "done" }]
      : [{ text: "first", ...(workerData.external || workerData.timer ? { gate: modelGate } : {}) }, { text: "done" }];
    const provider = new ScriptedProvider(scripts);
    const manager = new PluginManager({ directory: fileURLToPath(new URL("app", import.meta.url)), hostUrl: import.meta.url });
    [plugin] = await manager.load();
    const agent = new Agent({ id: "probe-agent", model: provider, tools: { tool }, limits: { maxTurns: 4 } });
    const controller = new Controller({ id: "probe-controller", agent, plugins: [plugin] });
    await controller.initialize();
    let session, done, events = [];
    if (workerData.target === "thread") {
      session = await controller.createSession();
      done = new Promise((resolve) => session.subscribe((event) => { events.push(event.type); if (event.type === "stream.end" || event.type === "stream.error") resolve(); }));
      await session.thread.create();
      if (!workerData.hook?.startsWith("session.")) await session.followUp(new HumanMessage("start"));
    } else {
      const stream = agent.stream("start", { id: "probe-target" });
      done = (async () => { for await (const event of stream) events.push(event.type); })();
    }
    if (workerData.external && !workerData.pauseOnly) {
      if (workerData.tool) await toolGate;
      else while (!provider.calls.length) await sleep(2);
      plugin.notify();
    } else {
      const entered = await bounded(plugin.entered.promise.then(() => ({ status: "entered" })), 500);
      if (entered.status === "pending") throw Error("Hook not reached: " + workerData.hook + " events=" + events.join(","));
      if (workerData.external) plugin.notify();
    }
    await plugin.receiptReady.promise;
    const before = await bounded(plugin.receipt);
    const callsBefore = provider.calls.length;
    const traceBefore = [...plugin.trace];
    plugin.release.resolve();
    releaseModel();
    const after = await bounded(plugin.receipt, 500);
    const completion = await bounded(done.then(() => ({ status: "completed" })), 500);
    const row = { name: workerData.name, before, callsBefore, traceBefore, after, completion, callsAfter: provider.calls.length };
    if (completion.status === "completed") {
      await controller.dispose(); manager.dispose();
    }
    parentPort.postMessage(row);
  } catch (error) { parentPort.postMessage({ name: workerData.name, fatal: error.stack }); }
}
