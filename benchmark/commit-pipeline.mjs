import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { Agent, Controller, HumanMessage, AssistantMessage, MessageCodec, createTool, createMemoryBackend } from "@tessar/core";
import { immutable } from "../packages/core/dist/helpers/json.js";
import { canonicalJson, fingerprint, validateBatch } from "../packages/core/dist/state/commit.js";

const TOOL_STEPS = 10;
const HISTORY_SIZE = 100;
const TEXT_SIZE = 1024;
const WARMUPS = 2;
const SAMPLES = 5;
const ITERATIONS = 20;
const OBSERVED_AT = "2026-11-20T00:00:00.000Z";
const STACK_FRAMES = 30;

async function inspect(historySize, steps) {
  const backend = createMemoryBackend();
  const clone = globalThis.structuredClone;
  const stringify = JSON.stringify;
  const stackFrames = Error.stackTraceLimit;
  const previous = new Map();
  const stats = {
    commits: 0, publishedRecordVersions: 0, serializedRecordEntries: 0,
    commitsByCause: {}, commitsWithoutRecordChanges: 0,
    unchangedRecordSerializations: 0, postPublishCheckpointClones: 0,
    serializedRecordBytes: 0, unchangedRecordBytes: 0,
    messagesCopiedAfterPublish: 0, usageAggregationsInCommit: 0, usageAggregationsOutsideCommit: 0,
    coordinatorMessageContentClones: 0,
  };
  let enabled = false, representative, modelCalls = 0, toolCalls = 0;
  const stage = backend.commits.stage.bind(backend.commits);
  const publish = backend.commits.publish.bind(backend.commits);
  const stagedIds = [];
  backend.commits.stage = async batch => {
    stats.commits++;
    stats.commitsByCause[batch.checkpoint.cause] = (stats.commitsByCause[batch.checkpoint.cause] ?? 0) + 1;
    if (!batch.records.length) stats.commitsWithoutRecordChanges++;
    stats.publishedRecordVersions += batch.records.length;
    stagedIds.push(batch.commitId);
    representative = clone(batch);
    return stage(batch);
  };
  let published = 0;
  backend.commits.publish = async request => { const receipt = await publish(request); published++; return receipt; };
  const replies = Array.from({ length: steps + 1 }, (_, index) => {
    const message = MessageCodec.encode(new AssistantMessage(index < steps
      ? [{ type: "tool-call", toolCallId: "call-" + index, name: "work", arguments: { step: index } }]
      : "done", { id: "answer-" + index }));
    const identity = { messageId: message.id, partId: "part", partIndex: 0 };
    const kind = index < steps ? "tool.call" : "text";
    return [
      { type: kind + ".start", ...identity, startedAt: OBSERVED_AT, boundary: "observed" },
      { ...message.content[0], type: kind + ".end", ...identity, startedAt: OBSERVED_AT, endedAt: OBSERVED_AT, boundary: "observed", status: "completed" },
      { type: "response", response: { message, finishReason: index < steps ? "tool_calls" : "stop" } },
    ];
  });
  const model = {
    ref: { providerId: "commit-fixture", modelId: "fixed" }, validate() {},
    async *stream() { const reply = replies[modelCalls++]; assert.ok(reply); yield* reply; },
  };
  const work = createTool({ name: "work", description: "Fixture", schema: z.object({ step: z.number() }),
    execute: ({ step }) => { toolCalls++; return { step, result: "ok" }; } });
  const controller = new Controller({ id: "commit-fixture", agent: new Agent({ id: "agent", model, tools: { work } }),
    plugins: [{ id: "storage", setup(context) { context.storage.register(backend); } }] });
  await controller.initialize();
  const input = Array.from({ length: historySize }, (_, index) => MessageCodec.encode(
    index % 2 ? new AssistantMessage("a".repeat(TEXT_SIZE)) : new HumanMessage("h".repeat(TEXT_SIZE)),
  ));
  input.push(MessageCodec.encode(new HumanMessage("run")));
  JSON.stringify = function (value, ...args) {
    const result = stringify(value, ...args);
    if (enabled && value?.kind && value?.threadId && value?.data && new Error().stack.includes("commitNow")) {
      stats.serializedRecordEntries++;
      stats.serializedRecordBytes += Buffer.byteLength(result);
      const key = value.kind + ":" + value.id;
      if (previous.get(key) === result) {
        stats.unchangedRecordSerializations++;
        stats.unchangedRecordBytes += Buffer.byteLength(result);
      }
      previous.set(key, result);
    }
    return result;
  };
  globalThis.structuredClone = function (value, ...args) {
    if (enabled && value && typeof value === "object") {
      if (value.state?.messages && value.currentCheckpointId === undefined && value.schemaVersion === 1) {
        if (new Error().stack.includes("commitNow")) {
          stats.postPublishCheckpointClones++;
          stats.messagesCopiedAfterPublish += value.state.messages.length;
        }
      } else if (value.metrics) {
        const stack = new Error().stack;
        if (stack.includes("updateUsage")) {
          if (stack.includes("commitNow")) stats.usageAggregationsInCommit++;
          else stats.usageAggregationsOutsideCommit++;
        }
      } else if (Array.isArray(value) && value[0]?.type && new Error().stack.includes("validateBatch")) {
        const stack = new Error().stack;
        if (!stack.includes("memory-backend.js")) {
          stats.coordinatorMessageContentClones++;
        }
      }
    }
    return clone(value, ...args);
  };
  let final;
  try {
    Error.stackTraceLimit = STACK_FRAMES;
    enabled = true;
    for await (const event of controller.agent.stream(input))
      if (event.type === "state_changed") final = event.payload.state;
    enabled = false;
    assert.equal(final.status, "completed");
    assert.equal(final.messages.at(-1).content[0].text, "done");
    assert.equal(modelCalls, steps + 1);
    assert.equal(toolCalls, steps);
    assert.equal(published, stats.commits);
    assert.equal(new Set(stagedIds).size, stats.commits);
    assert.equal(stats.usageAggregationsOutsideCommit, 2, "Only finish() needs pre-commit usage aggregation");
    assert.equal(stats.serializedRecordEntries - stats.unchangedRecordSerializations, stats.publishedRecordVersions);
    return { historySize, steps, modelCalls, toolCalls, stats, representative,
      finalRecordSet: [...previous.values()].map(value => JSON.parse(value)) };
  } finally {
    enabled = false;
    JSON.stringify = stringify;
    globalThis.structuredClone = clone;
    Error.stackTraceLimit = stackFrames;
    await controller.dispose();
    await backend.close();
  }
}

async function measure(name, operation) {
  const samples = [];
  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    globalThis.gc?.();
    const started = performance.now();
    for (let iteration = 0; iteration < ITERATIONS; iteration++) await operation();
    const elapsedMs = performance.now() - started;
    if (sample >= 0) samples.push(elapsedMs / ITERATIONS);
  }
  return { name, samplesMsPerCall: samples, medianMsPerCall: [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] };
}

const cases = [];
for (const [historySize, steps] of [[0, 0], [HISTORY_SIZE, 0], [HISTORY_SIZE, TOOL_STEPS]]) {
  const { representative: batch, finalRecordSet, ...counts } = await inspect(historySize, steps);
  const frozen = immutable(batch);
  const stringContent = structuredClone(batch);
  stringContent.checkpoint.state.messages[0].content = "normalized text";
  assert.doesNotThrow(() => validateBatch(stringContent));
  const extraArrayProperty = structuredClone(batch);
  extraArrayProperty.checkpoint.state.messages[0].content.extra = () => {};
  assert.throws(() => validateBatch(extraArrayProperty), error => error.name === "DataCloneError");
  const encoded = new TextEncoder().encode(canonicalJson(frozen));
  const expectedHash = Buffer.from(await crypto.subtle.digest("SHA-256", encoded)).toString("hex");
  assert.equal(await fingerprint(frozen), expectedHash);
  const clone = globalThis.structuredClone;
  let validationClones = 0;
  globalThis.structuredClone = (...args) => { validationClones++; return clone(...args); };
  try { validateBatch(frozen); }
  finally { globalThis.structuredClone = clone; }
  const micro = [];
  for (const [name, operation] of [
    ["validateBatch.mutable", () => validateBatch(batch)],
    ["validateBatch.frozen", () => validateBatch(frozen)],
    ["clone.checkpoint", () => structuredClone(batch.checkpoint)],
    ["serialize.recordSet", () => finalRecordSet.map(record => JSON.stringify(record))],
    ["canonicalJson.frozen", () => canonicalJson(frozen)],
    ["sha256.preparedBytes", () => crypto.subtle.digest("SHA-256", encoded)],
    ["fingerprint.frozen", () => fingerprint(frozen)],
  ]) micro.push(await measure(name, operation));
  cases.push({ ...counts, finalMessages: batch.checkpoint.state.messages.length,
    finalRecords: finalRecordSet.length,
    canonicalBytes: encoded.byteLength, validationClonesPerCall: validationClones, micro });
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  note: "Counters instrument real executions; microbenchmarks run separately without instrumentation. No task latency is measured.",
  warmups: WARMUPS, samples: SAMPLES, iterationsPerSample: ITERATIONS, cases }, null, 2));
