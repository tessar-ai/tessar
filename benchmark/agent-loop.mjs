import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";

const corePath = process.env.TESSAR_BENCH_CORE;
const coreImport = corePath ? pathToFileURL(resolve(corePath)).href : "@tessar/core";
// Storage adapters must use the same core build as the Agent in baseline runs.
if (corePath) registerHooks({ resolve(specifier, context, next) {
  return next(specifier === "@tessar/core" ? coreImport : specifier, context);
} });
const { Agent, AssistantMessage, Controller, HumanMessage, MessageCodec, createMemoryBackend, createTool, stateChanged, text } =
  await import(coreImport);
const postgresUrl = process.env.TESSAR_BENCH_POSTGRES_URL;
const postgres = postgresUrl ? { ...await import("pg"), ...await import("@tessar/postgresql") } : undefined;
const retainedSchemas = [];
const CONNECTION_TIMEOUT_MS = 5000;
const POSTGRES_SCHEMA_PREFIX = "tessar_bench_";

const WARMUPS = 2;
const SAMPLES = 5;
const TOOL_STEPS = 10;
const HISTORY_MESSAGES = 100;
const HISTORY_TEXT_SIZE = 1024;
const DELTAS = 128;
const DELTA_TEXT = "0123456789abcdef";
const PLUGINS = 20;
const OBSERVED_AT = "2026-11-20T00:00:00.000Z";
const CASES = [
  { name: "tools-short", steps: TOOL_STEPS, history: 0, deltas: 1, plugins: 0 },
  { name: "tools-history", steps: TOOL_STEPS, history: HISTORY_MESSAGES, deltas: 1, plugins: 0 },
  { name: "stream-short", steps: 0, history: 0, deltas: DELTAS, plugins: 0 },
  { name: "stream-history", steps: 0, history: HISTORY_MESSAGES, deltas: DELTAS, plugins: 0 },
  { name: "stream-plugins", steps: 0, history: HISTORY_MESSAGES, deltas: DELTAS, plugins: PLUGINS },
  { name: "session-tools-history", steps: TOOL_STEPS, history: HISTORY_MESSAGES, deltas: 1, plugins: 0, session: true },
  { name: "session-stream-history", steps: 0, history: HISTORY_MESSAGES, deltas: DELTAS, plugins: 0, session: true },
];

function responses(configuration) {
  const scripts = [];
  for (let step = 0; step < configuration.steps; step++) {
    const message = MessageCodec.encode(new AssistantMessage([
      { type: "tool-call", toolCallId: "call-" + step, name: "work", arguments: { step } },
    ], { id: "assistant-" + step }));
    const identity = { messageId: message.id, partId: "tool-" + step, partIndex: 0 };
    scripts.push([
      { type: "tool.call.start", ...identity, startedAt: OBSERVED_AT, boundary: "observed" },
      { ...message.content[0], type: "tool.call.end", ...identity, startedAt: OBSERVED_AT, endedAt: OBSERVED_AT, boundary: "observed", status: "completed" },
      { type: "response", response: { message, finishReason: "tool_calls" } },
    ]);
  }
  const answer = DELTA_TEXT.repeat(configuration.deltas);
  const message = MessageCodec.encode(new AssistantMessage(answer, { id: "final-answer" }));
  const identity = { messageId: message.id, partId: "answer", partIndex: 0 };
  scripts.push([
    { type: "text.start", ...identity, startedAt: OBSERVED_AT, boundary: "observed" },
    ...Array.from({ length: configuration.deltas }, () => ({ type: "text.delta", ...identity, delta: DELTA_TEXT })),
    { type: "text.end", ...identity, startedAt: OBSERVED_AT, endedAt: OBSERVED_AT, boundary: "observed", status: "completed", text: answer },
    { type: "response", response: { message, finishReason: "stop" } },
  ]);
  return scripts;
}

async function run(configuration) {
  // Construct fixtures outside the measured execution; the fake provider only yields fixed chunks.
  const scripts = responses(configuration);
  let modelCalls = 0, toolCalls = 0, hookCalls = 0, snapshots = 0, commits = 0;
  const pool = postgres ? new postgres.Pool({ connectionString: postgresUrl, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS }) : undefined;
  const schema = pool ? POSTGRES_SCHEMA_PREFIX + crypto.randomUUID().replaceAll("-", "") : undefined;
  const backend = pool
    ? await postgres.createPostgresqlBackend({ pool, schema }).catch(async error => { await pool.end(); throw error; })
    : createMemoryBackend();
  if (schema) retainedSchemas.push(schema);
  const stage = backend.commits.stage.bind(backend.commits);
  backend.commits.stage = async batch => { commits++; return stage(batch); };
  const model = {
    ref: { providerId: "benchmark", modelId: "fixed" },
    validate() { },
    async *stream() {
      const chunks = scripts[modelCalls++];
      assert.ok(chunks, "Unexpected extra model call");
      yield* chunks;
    },
  };
  const work = createTool({
    name: "work", description: "Return a deterministic in-memory result", schema: z.object({ step: z.number() }),
    execute: ({ step }) => { toolCalls++; return { step, result: "ok" }; },
  });
  const agent = new Agent({
    id: "benchmark-agent", model, tools: { work },
    limits: { maxTurns: TOOL_STEPS + 1, maxModelAttempts: TOOL_STEPS + 1, maxToolCalls: TOOL_STEPS },
  });
  const controller = new Controller({
    id: "benchmark-controller", agent,
    plugins: [
      { id: "storage", setup(context) { context.storage.register(backend); } },
      ...Array.from({ length: configuration.plugins }, (_, index) => ({
        id: "observer-" + index,
        setup(context) { context.hook(text.delta, () => { hookCalls++; }); },
      })),
    ],
  });
  try {
    await controller.initialize();
    const input = Array.from({ length: configuration.history }, (_, index) => MessageCodec.encode(
      index % 2 === 0
        ? new HumanMessage("h".repeat(HISTORY_TEXT_SIZE), { id: "history-" + index })
        : new AssistantMessage("a".repeat(HISTORY_TEXT_SIZE), { id: "history-" + index }),
    ));
    const prompt = MessageCodec.encode(new HumanMessage("Run the fixed task", { id: "prompt" }));
    const session = configuration.session ? await controller.createSession() : undefined;
    if (session) { await session.thread.create({ messages: input }); commits = 0; }
    else input.push(prompt);
    globalThis.gc?.();
    const cpu = process.cpuUsage();
    const started = performance.now();
    let final;
    if (session) {
      const done = Promise.withResolvers();
      const unsubscribe = session.subscribe(event => {
        if (event.type !== stateChanged) return;
        snapshots++; final = event.payload.state;
        if (final.status === "completed" || final.status === "failed") done.resolve();
      });
      try {
        await session.followUp(prompt);
        await done.promise;
        while (!session.isIdle()) await setImmediate();
      } finally { unsubscribe(); }
    } else {
      for await (const event of agent.stream(input)) {
        if (event.type === stateChanged) { snapshots++; final = event.payload.state; }
      }
    }
    const elapsedMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    assert.equal(final?.status, "completed", JSON.stringify(final?.error));
    assert.equal(modelCalls, configuration.steps + 1);
    assert.equal(toolCalls, configuration.steps);
    assert.equal(hookCalls, configuration.plugins * configuration.deltas);
    assert.equal(final.messages.at(-1).content[0].text, DELTA_TEXT.repeat(configuration.deltas));
    return { elapsedMs, cpuMs: (used.user + used.system) / 1000, modelCalls, toolCalls, hookCalls, snapshots, commits };
  } finally {
    try { await controller.dispose(); await backend.close(); }
    finally { await pool?.end(); }
  }
}

const selectedCases = process.env.TESSAR_BENCH_CASES?.split(",");
if (selectedCases) for (const name of selectedCases) assert.ok(CASES.some(item => item.name === name), "Unknown benchmark case: " + name);
const results = [];
for (const configuration of CASES.filter(item => !selectedCases || selectedCases.includes(item.name))) {
  for (let iteration = 0; iteration < WARMUPS; iteration++) await run(configuration);
  const samples = [];
  for (let iteration = 0; iteration < SAMPLES; iteration++) samples.push(await run(configuration));
  const times = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b);
  results.push({ ...configuration, medianMs: times[Math.floor(times.length / 2)], samples });
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  core: corePath ?? "workspace", storage: postgres ? "postgresql" : "memory", retainedSchemas,
  warmups: WARMUPS, results }, null, 2));
