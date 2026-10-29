import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AssistantMessage, MessageCodec, createTool, normalizeUsage } from "@tessar/core";
import { AgentHarness } from "@tessar/core/testing";
import { LangfuseAdapter, OpenTelemetryPlugin } from "@tessar/opentelemetry";

const env = parseEnv(await readFile("D:/tessar-implement/.env", "utf8"));
assert.ok(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY, "Missing Langfuse test configuration");
const started = new Date(Date.now() - 1000).toISOString();
const threadId = "consistency-" + randomUUID();
const spans = [], receipts = [];
class ObservedLangfuse extends LangfuseAdapter {
  createExporter() {
    const exporter = super.createExporter();
    return {
      export(batch, done) {
        spans.push(...batch);
        exporter.export(batch, (result) => {
          receipts.push({ code: result.code, count: batch.length, names: batch.map((span) => span.name) });
          done(result);
        });
      },
      shutdown: () => exporter.shutdown(),
    };
  }
}
let entered, release;
const weatherEntered = new Promise((resolve) => { entered = resolve; });
const gate = new Promise((resolve) => { release = resolve; });
const call = (name, id) => ({ response: { message: MessageCodec.encode(new AssistantMessage([
  { type: "reasoning", text: "Synthetic test: call the next tool." },
  { type: "tool-call", name, toolCallId: id, arguments: {} },
])) } });
const h = await AgentHarness.create({
  instructions: "Synthetic Tessar contract verification. Values below are test data, not real weather.",
  tools: {
    get_current_time: createTool({ name: "time", description: "Return a synthetic test date", schema: z.object({}), execute: () => ({ date: "2026-10-24" }) }),
    get_weather: createTool({ name: "weather", description: "Return synthetic weather", schema: z.object({}), execute: async () => { entered(); await gate; return { minimum: 20, maximum: 30, synthetic: true }; } }),
  },
  modelScripts: [call("get_current_time", "time-call"), call("get_weather", "weather-call"), {
    response: { message: MessageCodec.encode(new AssistantMessage([
      { type: "reasoning", text: "The synthetic tool results are sufficient." },
      { type: "text", text: "Synthetic weather result: 20–30 degrees." },
    ])), usage: normalizeUsage({ inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 5 }) },
  }, { text: "Second follow-up completed.", usage: { inputTokens: 120, outputTokens: 10 } }],
  plugins: [new OpenTelemetryPlugin({ realtime: true, traceName: "Tessar consistency verification", tags: ["synthetic", "consistency"], adapters: [new ObservedLangfuse({
    publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY, baseUrl: env.LANGFUSE_BASE_URL,
  })] })],
});
const authorization = "Basic " + Buffer.from(env.LANGFUSE_PUBLIC_KEY + ":" + env.LANGFUSE_SECRET_KEY).toString("base64");
async function observations(traceId) {
  const url = new URL("/api/public/v2/observations", env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com");
  for (const [key, value] of Object.entries({ traceId, fields: "core,basic,io,metadata,time", fromStartTime: started, toStartTime: new Date(Date.now() + 1000).toISOString(), limit: "100" })) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, "Langfuse observation query failed: " + response.status);
  return (await response.json()).data ?? [];
}
async function waitFor(traceId, predicate, attempts = 15) {
  let rows = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    rows = await observations(traceId);
    if (predicate(rows)) return rows;
    await delay(2000);
  }
  return rows;
}
const completion = (session) => new Promise((resolve, reject) => {
  const stop = session.subscribe((event) => {
    if (event.type === "stream.end") { stop(); resolve(event.payload.status); }
    if (event.type === "stream.error") { stop(); reject(Error(event.payload.error.message)); }
  });
});
let early = [], sessionId;
try {
  const session = await h.controller.createSession({ threadId });
  sessionId = session.id;
  const done = completion(session);
  await session.followUp("Synthetic test: get the date, then get weather.");
  await weatherEntered;
  const firstTraceId = spans[0].spanContext().traceId;
  early = await waitFor(firstTraceId, (rows) => rows.some((row) => row.type === "GENERATION"));
  assert.ok(!spans.some((span) => span.attributes["tessar.observation.type"] === "agent"), "Root must remain active while weather waits");
  console.log(JSON.stringify({ stage: "while-tool-active", received: early.map((row) => ({ name: row.name, type: row.type })), exportReceipts: receipts.length }));
  release();
  assert.equal(await done, "completed");
  const second = completion(session);
  await session.followUp("Confirm the previous synthetic result.");
  assert.equal(await second, "completed");
} finally { release(); await h.dispose(); }

const roots = spans.filter((span) => span.attributes["tessar.observation.type"] === "agent");
assert.equal(roots.length, 2);
const traceIds = roots.map((span) => span.spanContext().traceId);
assert.equal(new Set(traceIds).size, 2);
const read = (value) => typeof value === "string" ? JSON.parse(value) : value;
const groups = [];
for (const traceId of traceIds) {
  const expected = spans.filter((span) => span.spanContext().traceId === traceId).length;
  const rows = await waitFor(traceId, (values) => values.length >= expected);
  assert.equal(rows.length, expected, "Missing Langfuse observations");
  assert.ok(rows.every((row) => row.sessionId === threadId), "All observations must group by Tessar Thread");
  const root = rows.find((row) => row.type === "AGENT");
  assert.ok(root);
  assert.equal(root.parentObservationId, null);
  for (const row of rows) {
    assert.equal(row.metadata.sessionId, sessionId);
    assert.ok(Date.parse(row.endTime) >= Date.parse(row.startTime));
    if (row.type === "GENERATION") {
      const input = read(row.input), output = read(row.output);
      assert.equal(input.messages[0].role, "system");
      assert.ok(output.content.length);
    }
    if (row.type === "TOOL") {
      assert.ok(row.metadata.toolDescription);
      assert.ok(row.metadata.toolParameters);
    }
  }
  groups.push({ traceId, observations: rows.map((row) => ({ name: row.name, type: row.type, parent: row.parentObservationId, start: row.startTime, end: row.endTime, sessionId: row.sessionId })) });
}
assert.ok(receipts.every((receipt) => receipt.code === 0));
const result = { threadId, sessionId, realtimeVisibleBeforeCompletion: early.length > 0, traceIds, groups, receipts };
await writeFile(new URL("consistency-result.json", import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ stage: "complete", threadId, traceIds, counts: groups.map((group) => group.observations.length), realtimeVisibleBeforeCompletion: result.realtimeVisibleBeforeCompletion }));
