import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createTool, AssistantMessage, MessageCodec } from "../../packages/core/dist/index.js";
import { AgentHarness } from "../../packages/core/dist/testing/index.js";
import { OpenTelemetryPlugin, LangfuseAdapter } from "../../packages/opentelemetry/dist/index.js";

const env = parseEnv(await readFile("D:/tessar-implement/.env", "utf8"));
const start = performance.now(), started = new Date().toISOString();
const events = [], batches = [], exported = [];
let entered, release;
const toolEntered = new Promise(resolve => { entered = resolve; });
const toolGate = new Promise(resolve => { release = resolve; });
class ObservedLangfuse extends LangfuseAdapter {
  createExporter() {
    const exporter = super.createExporter();
    return {
      export(spans, done) {
        exported.push(...spans);
        const batch = { atMs: Math.round(performance.now() - start), names: spans.map(span => span.name) };
        batches.push(batch);
        exporter.export(spans, result => { batch.code = result.code; done(result); });
      },
      shutdown: () => exporter.shutdown(),
    };
  }
}
const helper = createTool({
  name: "timing_gate", description: "Synthetic long-running tool for trace timing verification",
  schema: z.object({}), execute: async () => { entered(); await toolGate; return "finished"; },
});
const harness = await AgentHarness.create({
  tools: { timing_gate: helper },
  modelScripts: [
    { response: { message: MessageCodec.encode(new AssistantMessage([
      { type: "tool-call", name: "timing_gate", toolCallId: "timing-call", arguments: {} },
    ])) } },
    { text: "Timing check completed." },
  ],
  plugins: [
    new OpenTelemetryPlugin({ serviceName: "tessar-trace-timing-audit", traceName: "Live export timing audit", adapters: [new ObservedLangfuse({
      publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY, baseUrl: env.LANGFUSE_BASE_URL,
    })] }),
    { id: "timing-observer", setup(tessar) {
      for (const name of ["stream.started", "turn.start", "model.start", "model.end", "tool.start", "tool.end", "turn.end", "stream.end"])
        tessar.hook(name, event => { events.push({ name, atMs: Math.round(performance.now() - start), timestamp: event.timestamp }); });
      tessar.hook("input.prepare", async () => { events.push({ name: "input.prepare", atMs: Math.round(performance.now() - start) }); await delay(100); });
      tessar.hook("context.prepare", async () => { events.push({ name: "context.prepare", atMs: Math.round(performance.now() - start) }); await delay(150); });
    } },
  ],
});
const threadId = "timing-audit-" + randomUUID();
const traceId = createHash("sha256").update(threadId).digest("hex").slice(0, 32);
let beforeFinish;
try {
  const session = await harness.controller.createSession({ threadId });
  const done = new Promise((resolve, reject) => {
    const stop = session.subscribe(event => {
      if (event.type === "stream.end") { stop(); resolve(); }
      if (event.type === "stream.error") { stop(); reject(Error(event.payload.error.message)); }
    });
  });
  await session.followUp("Synthetic long-running tool timing check.");
  await toolEntered;
  await delay(6000);
  const polls = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = new URL("/api/public/v2/observations", env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com");
    for (const [key, value] of Object.entries({ traceId, fields: "core,basic", fromStartTime: started, toStartTime: new Date().toISOString(), limit: "100" })) url.searchParams.set(key, value);
    const response = await fetch(url, { headers: { Authorization: "Basic " + Buffer.from(env.LANGFUSE_PUBLIC_KEY + ":" + env.LANGFUSE_SECRET_KEY).toString("base64") }, signal: AbortSignal.timeout(15000) });
    const payload = await response.json();
    beforeFinish = {
      atMs: Math.round(performance.now() - start), status: response.status,
      streamEnded: events.some(event => event.name === "stream.end"),
      observations: payload.data?.map(row => ({ name: row.name, type: row.type, endTime: row.endTime })),
      batches: structuredClone(batches),
    };
    polls.push(beforeFinish);
    if (payload.data?.length) break;
    await delay(2000);
  }
  beforeFinish.polls = polls.map(({ polls, ...entry }) => entry);
  release();
  await done;
} finally { release(); await harness.dispose(); }
const hrMillis = value => value[0] * 1000 + value[1] / 1e6;
const result = { traceId, beforeFinish, events, batches,
  spans: exported.map(span => ({ name: span.name, start: new Date(hrMillis(span.startTime)).toISOString(), end: new Date(hrMillis(span.endTime)).toISOString() })),
};
await writeFile(new URL("audit-timing-result.json", import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
