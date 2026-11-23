import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TessarClient } from "@tessar/client";

const host = process.argv[2];
assert.ok(host === "hono" || host === "fastify", "Pass hono or fastify to select the fixture configuration");
const samples = 60;
const warmups = 15;
const workers = 8;
const requestsPerWorker = 80;
const viewers = 32;
const results = fileURLToPath(new URL("./results/", import.meta.url));
await mkdir(results, { recursive: true });
const cwd = await mkdtemp(join(results, "self-host-"));
await mkdir(join(cwd, "src"));
await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module" }));
await writeFile(join(cwd, "src/index.ts"), `
import { Agent, Controller, AssistantMessage, MessageCodec, createTool } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { Tessar${host === "hono" ? ", registerRoute" : ""} } from "@tessar/server";
import { z } from "zod";

let tools = 0;
const scripts = Array.from({ length: ${samples + warmups} }, (_, index) => [
  { response: { message: MessageCodec.encode(new AssistantMessage([
    { type: "tool-call", toolCallId: "work-" + index, name: "work", arguments: {} },
  ])), finishReason: "tool_calls" } },
  { text: "benchmark answer" },
]).flat();
const model = new ScriptedProvider(scripts);
const agent = new Agent({ id: "benchmark", model, tools: {
  work: createTool({ name: "work", description: "Return fixed data", schema: z.object({}), execute() { tools++; return "done"; } }),
} });
const metrics = () => ({ rss: process.memoryUsage.rss(), modelCalls: model.calls.length, tools });
export default new Tessar({ controllers: [new Controller({ id: "bench", agent })],
  server: { port: 0, ${host === "hono" ? `routes: [registerRoute("/metrics", { method: "GET", handler: c => c.json(metrics()) })]` : `configure(app) { app.get("/metrics", async () => metrics()); }`} },
});
`);

const child = spawn(process.execPath, [fileURLToPath(new URL("../packages/cli/dist/bin.js", import.meta.url)), "dev"], {
  cwd, stdio: ["ignore", "pipe", "inherit", "ipc"], windowsHide: true,
});
const exited = new Promise(resolve => child.once("exit", resolve));
const percentile = (values, ratio = 0.95) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * ratio) - 1];
try {
  const baseURL = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Server startup timed out")), 10000);
    child.once("error", reject);
    void exited.then(code => { clearTimeout(timer); reject(Error(`Server exited ${code}`)); });
    let output = "";
    child.stdout.on("data", chunk => {
      output += chunk;
      const match = /Tessar listening at (http:\/\/[^\s]+)\s/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const client = new TessarClient({ baseURL });
  const metrics = () => fetch(baseURL + "/metrics").then(response => response.json());
  const json = [], first = [], complete = [];
  await client.listAgents();
  const jsonStart = performance.now();
  await Promise.all(Array.from({ length: workers }, async () => {
    for (let i = 0; i < requestsPerWorker; i++) {
      const start = performance.now();
      assert.equal((await client.listAgents())[0].id, "benchmark");
      json.push(performance.now() - start);
    }
  }));
  const jsonPerSecond = json.length * 1000 / (performance.now() - jsonStart);
  const agent = client.getAgent("benchmark");
  for (let i = 0; i < samples + warmups; i++) {
    const start = performance.now();
    let firstAt, completedAt, state;
    for await (const event of await agent.stream("Do the benchmark task")) {
      firstAt ??= performance.now();
      state = event.payload.state;
      if (state.status === "completed") completedAt = performance.now();
    }
    assert.equal(state?.status, "completed");
    assert.equal(state.messages.at(-1).content[0].text, "benchmark answer");
    if (i >= warmups) { first.push(firstAt - start); complete.push(completedAt - start); }
  }
  const session = await client.getController("bench").createSession();
  await session.thread.create({ title: "SSE viewer benchmark" });
  const stop = new AbortController();
  const subscriptions = [];
  const before = await metrics();
  let rssWithViewers;
  try {
    for (let i = 0; i < viewers; i++) {
      const events = await session.state.stream({ signal: stop.signal });
      const iterator = events[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).done, false);
      subscriptions.push(iterator);
    }
    rssWithViewers = (await metrics()).rss;
  } finally {
    stop.abort();
    await Promise.all(subscriptions.map(iterator => iterator.return?.()));
  }
  assert.equal(before.tools, samples + warmups);
  assert.equal(before.modelCalls, (samples + warmups) * 2);
  console.log(JSON.stringify({ host, node: process.version, platform: process.platform, samples, warmups,
    workers, requestsPerWorker, viewers, jsonPerSecond, jsonP95Ms: percentile(json),
    sseFirstP95Ms: percentile(first), taskP95Ms: percentile(complete), rssBeforeViewers: before.rss, rssWithViewers,
  }, null, 2));
} finally {
  if (child.connected) child.send("shutdown");
  assert.equal(await exited, 0);
}
