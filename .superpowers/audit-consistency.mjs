import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Agent, Controller, AssistantMessage, MessageCodec, createTool, errorInfo, defineInterruption, ToolDecision } from "@tessar/core";
import { AgentHarness, ScriptedProvider } from "@tessar/core/testing";
import { OpenAIProvider } from "../packages/openai/dist/index.js";
import { createSqliteBackend } from "@tessar/sqlite";

const results = {};
const complete = (session) => new Promise((resolve) => {
  const stop = session.subscribe((event) => {
    if (["stream.end", "stream.error", "stream.suspended"].includes(event.type)) {
      stop(); resolve({ type: event.type, status: event.payload.status, code: event.payload.error?.code });
    }
  });
});

{
  const tool = createTool({ name: "original", description: "Probe", schema: z.object({}), execute: () => "ok" });
  const agent = new Agent({ id: "alias-probe", model: new ScriptedProvider([]), tools: { renamed: tool } });
  results.alias = { configuredKey: "renamed", actualToolName: agent.listTool()[0].name };
  assert.equal(results.alias.actualToolName, "original");
  await agent.shutdown();
}

{
  const h = await AgentHarness.create({ modelScripts: [{ text: "session succeeds" }] });
  try {
    let agentError;
    try { await h.agent.generate("hello", { modelOptions: { background: true } }); }
    catch (error) { agentError = error.code; }
    const session = await h.controller.createSession({ threadId: "options-probe" });
    await session.model.switch("test", { background: true });
    const done = complete(session);
    await session.followUp("hello");
    results.options = { agentError, session: await done, sentOptions: h.provider.calls[0]?.options };
    assert.equal(agentError, "UnsupportedOption");
    assert.equal(results.options.session.status, "completed");
  } finally { await h.dispose(); }
}

{
  const first = new OpenAIProvider({ model: "fixture", apiKey: "not-a-real-key", connectionId: "first" });
  const other = new OpenAIProvider({ model: "fixture", apiKey: "not-a-real-key", connectionId: "other" });
  const calls = [];
  other.stream = async function* (request) {
    calls.push(request.model);
    yield { type: "response", response: { message: MessageCodec.encode(new AssistantMessage("offline result")) } };
  };
  const agent = new Agent({ id: "connection-probe", model: first });
  const controller = new Controller({ id: "connection-controller", agent });
  try {
    await controller.initialize();
    const direct = await agent.generate("direct override", { model: other });
    const session = await controller.createSession({ threadId: "connection-thread", model: other });
    const done = complete(session);
    await session.followUp("session override");
    results.connection = { direct: direct.status, session: await done, providerCalls: calls.length };
    assert.equal(direct.status, "completed");
    assert.equal(results.connection.session.code, "ModelContextIncompatible");
  } finally { await controller.dispose(); }
}

{
  const notifications = [];
  const h = await AgentHarness.create({
    modelScripts: [{ text: "ok" }],
    plugins: [{ id: "error-probe", setup(tessar) {
      for (const name of ["ready", "thread.started", "stream.error"])
        tessar.hook(name, (event) => { notifications.push({ type: event.type, timestamp: event.timestamp ?? null }); });
    } }],
  });
  try {
    await h.collect(h.agent.stream("first", { id: "fixed-stream" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stream = h.agent.stream("duplicate", { id: "fixed-stream" });
    const seen = [];
    for await (const event of stream) if (event.type === "stream.error") seen.push(event.payload.error.code);
    results.events = { subscriberErrors: seen, hookErrors: notifications.filter((event) => event.type === "stream.error"), readyAndThreadEvents: notifications.filter((event) => event.type !== "stream.error") };
    assert.deepEqual(seen, ["RegistrationConflict"]);
    assert.equal(results.events.hookErrors.length, 0);
  } finally { await h.dispose(); }
}

{
  const h = await AgentHarness.create();
  try {
    h.backend.sessions.compareAndSet = async () => { throw Error("Storage offline"); };
    try { await h.controller.createSession(); }
    catch (error) { results.sessionStorageError = errorInfo(error).source; }
    h.backend.commits.stage = async () => { throw Error("Storage offline"); };
    try { await h.agent.generate("hello"); }
    catch (error) { results.commitStorageError = errorInfo(error).source; }
    assert.equal(results.sessionStorageError, "tessar");
    assert.equal(results.commitStorageError, "storage");
  } finally { await h.dispose(); }
}

{
  const h = await AgentHarness.create();
  const session = await h.controller.createSession();
  await h.dispose();
  let disposeError;
  try { await session.dispose(); } catch (error) { disposeError = error.code; }
  results.disposal = { controllerReady: h.controller.isReady(), sessionDisposed: session.isDisposed(), state: session.state.get().status, disposeError };
  assert.equal(session.isDisposed(), false);
  assert.equal(disposeError, "Disposed");
}

const directory = await mkdtemp(join(tmpdir(), "tessar-consistency-"));
try {
  results.resumeSchema = {};
  for (const registration of ["agent", "plugin"]) {
    const filename = join(directory, registration + ".db");
    let interruptId, threadId;
    const configurationIds = [];
    for (const revision of [0, 1]) {
      const work = createTool({ name: "work", description: "Work", schema: revision ? z.object({ extra: z.string().optional() }) : z.object({}), execute: () => "ok" });
      const approval = defineInterruption({ id: "approval", version: 1, response: { jsonSchema: {}, parse: () => ({}) }, resolve: () => ToolDecision.allow() });
      const h = await AgentHarness.create({
        backend: await createSqliteBackend({ filename }),
        tools: registration === "agent" ? { work } : undefined,
        modelScripts: revision ? [{ text: "done" }] : [{ response: { message: MessageCodec.encode(new AssistantMessage([{ type: "tool-call", toolCallId: "work", name: "work", arguments: {} }])) } }],
        plugins: [{ id: "work-plugin", setup(tessar) {
          if (registration === "plugin") tessar.tools.register(work);
          tessar.interruptions.register(approval);
          tessar.hook("tool.before", (_event, context) => context.suspend(approval, {}));
        } }],
      });
      try {
        if (!revision) {
          const pending = await h.agent.generate("work");
          interruptId = pending.interrupt.id; threadId = pending.threadId;
          const checkpoint = await h.checkpoint(threadId);
          configurationIds.push(checkpoint.execution.registryManifest.find((entry) => entry.kind === "tool").configurationId);
        } else {
          let status;
          try { await h.collect(h.agent.resume({ threadId, interruptId, value: {} })); status = "completed"; }
          catch (error) { status = error.code; }
          results.resumeSchema[registration] = { status, originalConfigurationId: configurationIds[0] };
        }
      } finally { await h.dispose(); }
    }
  }
  assert.equal(results.resumeSchema.agent.status, "ResumeIncompatible");
  assert.equal(results.resumeSchema.plugin.status, "completed");
} finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }

await writeFile(new URL("audit-consistency-result.json", import.meta.url), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
