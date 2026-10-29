import assert from "node:assert/strict";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const observed = (promise) => promise.then(() => ({ status: "fulfilled" }), (error) => ({ status: "rejected", code: error.code, message: error.message }));
const bounded = (promise) => Promise.race([promise, pause(150).then(() => ({ status: "pending" }))]);

if (isMainThread) {
  const cases = [
    { name: "abort-self-thread-prepare", kind: "admission", hook: "thread.prepare", action: "abort" },
    { name: "abort-self-thread-started", kind: "admission", hook: "thread.started", action: "abort" },
    { name: "dispose-self-thread-prepare", kind: "admission", hook: "thread.prepare", action: "dispose" },
    { name: "abort-transient-thread-prepare", kind: "admission", hook: "thread.prepare", persist: false, action: "abort" },
    { name: "cross-stream-admission", kind: "cross" },
    { name: "external-closing-thread-target", kind: "closing", target: "thread" },
    { name: "external-closing-stream-target", kind: "closing", target: "stream" },
    { name: "persisted-receipt-blocked-by-hook", kind: "commit" },
    { name: "persisted-receipt-rejected-after-commit", kind: "commit", throwAfterCommit: true },
    { name: "sqlite-receipt-rejected-after-commit", kind: "commit", throwAfterCommit: true, sqlite: true },
    { name: "parallel-commit-notifications-without-signals", kind: "parallel" },
    { name: "idle-thread-signal-burst", kind: "idle-burst" },
  ];
  const rows = [];
  for (const config of cases) {
    const row = await new Promise((done) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: config });
      const timer = setTimeout(() => { void worker.terminate(); done({ name: config.name, fatal: "timeout" }); }, 8000);
      worker.once("message", (value) => { clearTimeout(timer); void worker.terminate(); done(value); });
      worker.once("error", (error) => { clearTimeout(timer); done({ name: config.name, fatal: error.stack }); });
    });
    rows.push(row);
    console.log(JSON.stringify(row));
    assert.equal(row.fatal, undefined, row.name + ": " + row.fatal);
    if (config.kind === "admission") {
      assert.equal(row.before.status, "pending");
      assert.equal(row.afterAction.status, "pending");
      assert.equal(row.completionAfterAction.status, "pending");
      if (config.action === "dispose") assert.equal(row.disposalAfterAction.status, "pending");
    } else if (config.kind === "cross") {
      assert.deepEqual(row.before.map((value) => value.status), ["pending", "pending"]);
      assert.deepEqual(row.after.map((value) => value.status), ["fulfilled", "fulfilled"]);
    } else if (config.kind === "closing") {
      assert.equal(row.receipt.status, "rejected");
      assert.equal(row.receipt.code, "AlreadyTerminal");
    } else if (config.kind === "commit") {
      assert.equal(row.before.status, "pending");
      assert.equal(row.pendingInCheckpoint, 1);
      assert.equal(row.after.status, config.throwAfterCommit ? "rejected" : "fulfilled");
      if (config.throwAfterCommit) assert.equal(row.pendingAfterRejection, 1);
    } else if (config.kind === "parallel") {
      assert.equal(row.overlapped, true);
      assert.equal(row.signalCalls, 0);
    } else {
      assert.equal(row.second.status, "rejected");
      assert.equal(row.second.code, "InvalidTransition");
      assert.equal(row.first.status, "fulfilled");
    }
  }
  await writeFile(new URL("results.json", import.meta.url), JSON.stringify(rows, null, 2));
  console.log(JSON.stringify({ checked: rows.length, sourcesChanged: false }));
} else {
  try {
    const { Agent, Controller, HumanMessage, AssistantMessage, MessageCodec, createTool } = await import("@tessar/core");
    const { ScriptedProvider } = await import("@tessar/core/testing");
    const { PluginManager } = await import("@tessar/plugins");
    let releaseModel;
    const modelGate = new Promise((done) => { releaseModel = done; });
    let releaseTools, enterTools;
    const toolGate = new Promise((done) => { releaseTools = done; });
    const bothTools = new Promise((done) => { enterTools = done; });
    let toolsEntered = 0;
    const { z } = await import("zod");
    const tool = createTool({ name: "work", description: "probe", schema: z.object({}), execute: async () => {
      if (++toolsEntered === 2) enterTools();
      await toolGate;
      return "finished";
    } });
    const scripts = workerData.kind === "parallel" ? [{ response: { message: MessageCodec.encode(new AssistantMessage([
      { type: "tool-call", name: "work", toolCallId: "one", arguments: {} },
      { type: "tool-call", name: "work", toolCallId: "two", arguments: {} },
    ])) } }, { text: "done" }] : workerData.kind === "commit" ? [{ text: "first", gate: modelGate }, { text: "second" }]
      : [{ text: "first" }, { text: "second" }];
    const provider = new ScriptedProvider(scripts);
    const manager = new PluginManager({ directory: fileURLToPath(new URL("app", import.meta.url)), hostUrl: import.meta.url });
    const [plugin] = await manager.load();
    const agent = new Agent({ id: "audit-agent", model: provider, tools: { tool } });
    const plugins = [plugin];
    if (workerData.sqlite) {
      const { SqliteStoragePlugin } = await import("@tessar/sqlite");
      plugins.push(new SqliteStoragePlugin({ filename: fileURLToPath(new URL(randomUUID() + ".sqlite", import.meta.url)) }));
    }
    const controller = new Controller({ id: "audit-controller", agent, plugins });
    await controller.initialize();
    let target, completion;
    if ((workerData.kind === "closing" && workerData.target === "thread") || workerData.kind === "idle-burst") {
      const session = await controller.createSession();
      await session.thread.create();
      completion = new Promise((done) => session.subscribe((event) => { if (event.type === "stream.end" || event.type === "stream.error") done(); }));
      target = { threadId: session.thread.getId() };
      if (workerData.kind === "idle-burst") {
        const firstReceipt = observed(agent.sendSignal({ ...target, content: "first notification" }));
        await plugin.entered.promise;
        const second = await bounded(observed(agent.sendSignal({ ...target, content: "second notification" })));
        plugin.release.resolve();
        const first = await bounded(firstReceipt);
        await completion;
        const history = JSON.stringify(await session.thread.getHistory());
        await controller.dispose();
        parentPort.postMessage({ name: workerData.name, first, second, historyHasFirst: history.includes("first notification"), historyHasSecond: history.includes("second notification") });
      } else await session.followUp(new HumanMessage("start"));
    } else {
      const stream = agent.stream("start", { id: "target-a" });
      target = { streamId: stream.id };
      completion = observed((async () => { for await (const event of stream) {} })());
      if (workerData.kind === "cross") {
        const second = agent.stream("start", { id: "target-b" });
        completion = Promise.all([completion, observed((async () => { for await (const event of second) {} })())]);
      }
      if (workerData.kind === "admission") {
        await plugin.entered.promise;
        const before = await bounded(plugin.receipts[0]);
        let disposal;
        if (workerData.action === "abort") stream.abort("diagnostic abort");
        else disposal = observed(controller.dispose());
        const afterAction = await bounded(plugin.receipts[0]);
        const completionAfterAction = await bounded(completion);
        const disposalAfterAction = disposal ? await bounded(disposal) : undefined;
        plugin.release.resolve();
        const afterEscape = await bounded(plugin.receipts[0]);
        const completionAfterEscape = await bounded(completion);
        if (!disposal) disposal = observed(controller.dispose());
        await disposal;
        parentPort.postMessage({ name: workerData.name, before, afterAction, completionAfterAction, disposalAfterAction, afterEscape, completionAfterEscape, calls: provider.calls.length });
      }
    }
    if (workerData.kind === "cross") {
      await plugin.entered.promise;
      const before = await Promise.all(plugin.receipts.map(bounded));
      const callsBefore = provider.calls.length;
      plugin.release.resolve();
      const after = await Promise.all(plugin.receipts.map(bounded));
      await completion;
      await controller.dispose();
      parentPort.postMessage({ name: workerData.name, before, after, callsBefore, callsAfter: provider.calls.length, trace: plugin.trace });
    } else if (workerData.kind === "closing") {
      await plugin.entered.promise;
      const receipt = await bounded(observed(agent.sendSignal({ ...target, content: "outside notification" })));
      plugin.release.resolve();
      await completion;
      await controller.dispose();
      parentPort.postMessage({ name: workerData.name, receipt, calls: provider.calls.length });
    } else if (workerData.kind === "parallel") {
      await bothTools;
      plugin.armed = true;
      releaseTools();
      await plugin.entered.promise;
      await pause(150);
      const traceBeforeRelease = [...plugin.trace];
      const overlapped = traceBeforeRelease.some((entry) => entry.startsWith("exit:") && Number(entry.slice(5)) > plugin.blockedRevision);
      plugin.release.resolve();
      await completion;
      await controller.dispose();
      parentPort.postMessage({ name: workerData.name, overlapped, signalCalls: 0, traceBeforeRelease });
    } else if (workerData.kind === "commit") {
      while (!provider.calls.length) await pause(1);
      plugin.armed = true;
      const receipt = observed(agent.sendSignal({ ...target, content: "committed notification" }));
      await plugin.entered.promise;
      const before = await bounded(receipt);
      const streamRecord = await controller.backend.executions.get("streams", target.streamId);
      const checkpoint = await controller.queries.snapshot(streamRecord.threadId);
      const pendingInCheckpoint = checkpoint.execution?.pendingSignals?.length ?? 0;
      if (!workerData.throwAfterCommit) releaseModel();
      const completionWhileHookBlocked = await bounded(completion);
      plugin.release.resolve();
      const after = await bounded(receipt);
      const pendingAfterRejection = (await controller.queries.snapshot(streamRecord.threadId)).execution?.pendingSignals?.length ?? 0;
      releaseModel();
      await completion;
      await controller.dispose();
      parentPort.postMessage({ name: workerData.name, before, pendingInCheckpoint, completionWhileHookBlocked, after, pendingAfterRejection, calls: provider.calls.length, deliveredToProvider: JSON.stringify(provider.calls.slice(1)).includes("committed notification") });
    }
  } catch (error) { parentPort.postMessage({ name: workerData.name, fatal: error.stack }); }
}
