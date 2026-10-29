import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { z } from "zod";
import { AssistantMessage, MessageCodec, createTool, buildInstruction } from "../../packages/core/dist/index.js";
import { AgentHarness } from "../../packages/core/dist/testing/index.js";
import { OpenTelemetryPlugin, LangfuseAdapter, ArizeAdapter, TraceloopAdapter } from "../../packages/opentelemetry/dist/index.js";

const env = parseEnv(await readFile("D:/tessar-implement/.env", "utf8"));
const receipts = [];
const adapters = [];
const observe = (name, adapter) => ({ name, createExporter() {
  const exporter = adapter.createExporter();
  return {
    export(spans, done) { exporter.export(spans, result => {
      receipts.push({ platform: name, code: result.code, count: spans.length, error: result.error?.message });
      done(result);
    }); },
    shutdown: () => exporter.shutdown(),
  };
} });
if (env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY)
  adapters.push(observe("Langfuse", new LangfuseAdapter({ publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY, baseUrl: env.LANGFUSE_BASE_URL })));
if (env.ARIZE_API_KEY && env.ARIZE_SPACE_ID && env.ARIZE_PROJECT_NAME)
  adapters.push(observe("Arize", new ArizeAdapter({ apiKey: env.ARIZE_API_KEY, spaceId: env.ARIZE_SPACE_ID, projectName: env.ARIZE_PROJECT_NAME, endpoint: env.ARIZE_COLLECTOR_ENDPOINT })));
if (env.TRACELOOP_API_KEY)
  adapters.push(observe("Traceloop", new TraceloopAdapter({ apiKey: env.TRACELOOP_API_KEY, endpoint: (env.TRACELOOP_BASE_URL || "https://api.traceloop.com").replace(/\/$/, "") + "/v1/traces" })));
assert.ok(adapters.length);
const response = (name, id, args) => ({ response: { message: MessageCodec.encode(new AssistantMessage([
  { type: "reasoning", text: "Use the next tool." },
  { type: "tool-call", name, toolCallId: id, arguments: args },
])) } });
const harness = await AgentHarness.create({
  instructions: buildInstruction([
    { id: "base", content: "Synthetic telemetry tool mapping verification.", order: 0 },
    { id: "persona", content: "Keep all earlier tool results in context.", order: 10 },
  ]),
  tools: {
    get_current_time: createTool({ name: "get_current_time", description: "Get current date", schema: z.object({}), execute: () => ({ date: "2026-10-23" }) }),
    get_weather: createTool({ name: "get_weather", description: "Get weather for a date", schema: z.object({ date: z.string() }), execute: ({ date }) => ({ date, temperature: 30 }) }),
  },
  modelScripts: [response("get_current_time", "time-call", {}), response("get_weather", "weather-call", { date: "2026-10-23" }), { text: "Synthetic weather result: 30 degrees." }],
  plugins: [new OpenTelemetryPlugin({ serviceName: "tessar-tool-mapping-check", traceName: "Tool mapping verification", tags: ["mapping-check"], adapters: adapters.filter(adapter => !process.argv[2] || adapter.name === process.argv[2]) })],
});
const threadId = "mapping-check-" + randomUUID();
const started = new Date().toISOString();
try {
  const session = await harness.controller.createSession({ threadId });
  const done = new Promise((resolve, reject) => {
    const stop = session.subscribe(event => {
      if (event.type === "stream.error") { stop(); reject(Error(event.payload.error.message)); }
      if (event.type === "stream.end") { stop(); resolve(event.payload.status); }
    });
  });
  await session.followUp("Check the date then the weather.");
  assert.equal(await done, "completed");
} finally { await harness.dispose(); }
const result = { threadId, traceId: createHash("sha256").update(threadId).digest("hex").slice(0, 32), started, receipts };
await writeFile(new URL("tool-mapping-result.json", import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
assert.ok(receipts.length && receipts.every(receipt => receipt.code === 0));
