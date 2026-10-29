import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AssistantMessage, MessageCodec, createTool, normalizeUsage } from "../../packages/core/dist/index.js";
import { AgentHarness } from "../../packages/core/dist/testing/index.js";
import { ArizeAdapter, OpenTelemetryPlugin } from "../../packages/opentelemetry/dist/index.js";

const env = parseEnv(await readFile("D:/tessar-implement/.env", "utf8"));
assert.ok(env.ARIZE_API_KEY && env.ARIZE_SPACE_ID && env.ARIZE_PROJECT_NAME, "Missing Arize configuration");
const headers = { Authorization: "Bearer " + env.ARIZE_API_KEY, "Content-Type": "application/json" };
async function api(path, body) {
  const response = await fetch("https://api.arize.com" + path, {
    method: body ? "POST" : "GET", headers,
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200, "Arize query HTTP " + response.status);
  return response.json();
}
const projects = await api("/v2/projects?space_id=" + encodeURIComponent(env.ARIZE_SPACE_ID));
const project = projects.projects.find(value => value.name === env.ARIZE_PROJECT_NAME);
assert.ok(project, "Configured Arize project missing");
const receipts = [], captured = [];
class ObservedArize extends ArizeAdapter {
  createExporter() {
    const exporter = super.createExporter();
    return {
      export: (spans, done) => {
        captured.push(...spans);
        exporter.export(spans, result => { receipts.push({ code: result.code, count: spans.length, error: result.error?.message }); done(result); });
      },
      shutdown: () => exporter.shutdown(),
    };
  }
}
const started = new Date(Date.now() - 1000).toISOString();
const threadId = "arize-check-" + randomUUID();
const otherId = threadId + "-other";
const call = (name, id, args) => ({ response: { message: MessageCodec.encode(new AssistantMessage([
  { type: "reasoning", text: "Check the synthetic tool." },
  { type: "tool-call", name, toolCallId: id, arguments: args },
  { type: "text", text: "Checking." },
])), usage: normalizeUsage({ inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 5 }) } });
const h = await AgentHarness.create({
  instructions: "Synthetic Arize verification. Keep all earlier tool results in context.",
  tools: {
    get_current_time: createTool({ name: "get_current_time", description: "Read the synthetic date", schema: z.object({}), execute: () => ({ date: "2026-10-25" }) }),
    get_weather: createTool({ name: "get_weather", description: "Read synthetic weather", schema: z.object({ date: z.string() }), execute: ({ date }) => ({ date, temperature: 30 }) }),
  },
  modelScripts: [call("get_current_time", "arize-time", {}), call("get_weather", "arize-weather", { date: "2026-10-25" }), {
    response: { message: MessageCodec.encode(new AssistantMessage([
      { type: "reasoning", text: "The synthetic weather data is sufficient." },
      { type: "text", text: "It is 30 degrees." },
    ])), usage: normalizeUsage({ inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 5 }) },
  }, { text: "Bring water.", usage: { inputTokens: 120, outputTokens: 10 } }, { text: "A separate conversation.", usage: { inputTokens: 20, outputTokens: 5 } }],
  plugins: [new OpenTelemetryPlugin({ realtime: true, serviceName: "tessar-arize-check", tags: ["arize-verification"], adapters: [new ObservedArize({
    apiKey: env.ARIZE_API_KEY, spaceId: env.ARIZE_SPACE_ID, projectName: env.ARIZE_PROJECT_NAME,
    ...(env.ARIZE_COLLECTOR_ENDPOINT ? { endpoint: env.ARIZE_COLLECTOR_ENDPOINT } : {}),
  })] })],
});
let sessionId;
try {
  const session = await h.controller.createSession({ threadId });
  sessionId = session.id;
  const ask = async text => {
    let stop = () => {};
    const done = new Promise((resolve, reject) => { stop = session.subscribe(event => {
      if (event.type === "stream.end") resolve(event.payload.status);
      if (event.type === "stream.error") reject(Error(event.payload.error.message));
    }); });
    try { const results = await Promise.all([session.followUp(text), done]); assert.equal(results[1], "completed"); }
    finally { stop(); }
  };
  await ask("Synthetic test: get date, then weather.");
  await ask("Use the earlier result to give advice.");
  await session.thread.create({ id: otherId });
  await ask("Start a separate conversation.");
} finally { await h.dispose(); }
assert.ok(receipts.length && receipts.every(receipt => receipt.code === 0));
const traceIds = [...new Set(captured.map(span => span.spanContext().traceId))];
let rows = [];
for (let attempt = 0; attempt < 15; attempt++) {
  const result = await api("/v2/spans?limit=100", { project_id: project.id, start_time: started, end_time: new Date().toISOString() });
  rows = result.spans.filter(span => [threadId, otherId].includes(span.attributes["session.id"]));
  if (rows.length >= captured.length) break;
  await delay(2000);
}
await writeFile(new URL("arize-check-spans.json", import.meta.url), JSON.stringify({ threadId, otherId, sessionId, traceIds, rows, receipts }, null, 2));
assert.equal(rows.length, captured.length, "Missing Arize observations");
assert.equal(rows.filter(row => row.kind === "AGENT").length, 3);
assert.equal(new Set(rows.map(row => row.attributes["session.id"])).size, 2);
for (const row of rows) {
  const a = row.attributes;
  assert.deepEqual(a["tag.tags"], ["arize-verification"]);
  assert.equal(a.metadata.sessionId, sessionId);
  assert.equal(a.metadata.threadId, a["session.id"]);
  assert.ok(Date.parse(row.end_time) >= Date.parse(row.start_time));
  if (row.kind === "LLM") {
    assert.equal(a["llm.input_messages"][0]["message.role"], "system");
    assert.ok(a["llm.token_count.prompt"] > 0);
    assert.equal(a["output.mime_type"], "text/plain");
    for (const message of a["llm.output_messages"] ?? []) {
      assert.ok(!(message["message.contents"] ?? []).some(part => part["message_content.type"] === "tool_use"));
      for (const call of message["message.tool_calls"] ?? []) {
        assert.ok(call["tool_call.id"]);
        assert.ok(call["tool_call.function.name"]);
        assert.equal(typeof call["tool_call.function.arguments"], "string");
      }
    }
  }
  if (row.kind === "TOOL") { assert.ok(a["tool.description"]); assert.ok(a["tool.parameters"]); }
  if (row.kind === "AGENT") {
    const input = typeof a["input.value"] === "string" ? JSON.parse(a["input.value"]) : a["input.value"];
    assert.deepEqual(input.map(message => message.role), ["system", "user"]);
    assert.equal(input[0].content[0].text, "Synthetic Arize verification. Keep all earlier tool results in context.");
  }
  if (row.kind === "AGENT" || row.kind === "CHAIN") {
    assert.equal(a["input.mime_type"], "application/json");
    assert.equal(a["output.mime_type"], "application/json");
    for (const key of ["input.value", "output.value"]) {
      const messages = typeof a[key] === "string" ? JSON.parse(a[key]) : a[key];
      assert.ok(Array.isArray(messages));
      for (const message of messages) {
        assert.equal(typeof message.role, "string");
        assert.ok(Array.isArray(message.content));
        assert.ok(!("schemaVersion" in message));
        assert.ok(!("providerState" in message));
      }
    }
  }
}
console.log(JSON.stringify({ threadId, otherId, sessionId, traceIds, expected: captured.length, received: rows.length, receipts,
  sample: rows.filter(span => span.kind === "LLM").slice(0, 2).map(span => ({ name: span.name, session: span.attributes["session.id"], messages: span.attributes["llm.output_messages"], tags: span.attributes["tag.tags"] })) }));
