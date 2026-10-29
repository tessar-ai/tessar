import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { Agent, Controller } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { LangfusePlugin } from "@tessar/langfuse";

const batches: unknown[] = [];
const server = createServer(async (request, response) => {
  assert.equal(request.url, "/api/public/otel/v1/traces");
  assert.equal(request.headers.authorization, "Basic " + Buffer.from("pk-test:sk-test").toString("base64"));
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const data = Buffer.concat(chunks);
  batches.push(JSON.parse((request.headers["content-encoding"] === "gzip" ? gunzipSync(data) : data).toString("utf8")));
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end("{}");
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const agent = new Agent({ id: "consumer", model: new ScriptedProvider([
    { text: "built trace answer", usage: { inputTokens: 3, outputTokens: 2 } },
    { text: "first Session answer" }, { text: "second Session answer" },
  ]) });
  const controller = new Controller({
    id: "consumer-tracing",
    agent,
    plugins: [new LangfusePlugin({
      publicKey: "pk-test", secretKey: "sk-test", baseUrl: `http://127.0.0.1:${address.port}`,
    })],
  });
  try {
    await controller.initialize();
    assert.equal((await agent.generate("hello")).status, "completed");
    const session = await controller.createSession({ threadId: "built-thread" });
    for (const text of ["first question", "second question"]) {
      const done = new Promise<void>((resolve, reject) => {
        const stop = session.subscribe(event => {
          if (event.type === "stream.end") { stop(); resolve(); }
          if (event.type === "stream.error") { stop(); reject(Error(event.payload.error.message)); }
        });
      });
      await session.followUp(text); await done;
    }
  } finally {
    await controller.dispose();
  }
  assert.ok(batches.length > 0);
  const exported = JSON.stringify(batches);
  assert.ok(exported.includes("built trace answer"));
  assert.ok(exported.includes("langfuse.observation.usage_details"));
  assert.ok(!exported.includes("sk-test"));
  type Payload = { resourceSpans: { scopeSpans: { spans: {
    name: string; traceId: string; spanId: string; parentSpanId?: string;
  }[] }[] }[] };
  const spans = (batches as Payload[]).flatMap(batch => batch.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));
  assert.equal(new Set(spans.map(span => span.traceId)).size, 2);
  assert.equal(spans.filter(span => span.name === "consumer").length, 2);
  const secondTurn = spans.find(span => span.name === "turn 2")!;
  assert.ok(secondTurn);
  const root = spans.find(span => span.spanId === secondTurn.parentSpanId)!;
  assert.equal(root.name, "consumer");
  assert.equal(root.traceId, secondTurn.traceId);
  assert.ok(spans.some(span => span.name === "turn 1" && span.parentSpanId === root.spanId));
  assert.equal(new Set(spans.map(span => span.spanId)).size, spans.length);
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
