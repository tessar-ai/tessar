import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { Agent, Controller } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { OpenTelemetryPlugin, LangfuseAdapter } from "@tessar/opentelemetry";

const batches: unknown[] = [];
const server = createServer(async (request, response) => {
  assert.equal(request.url, "/api/public/otel/v1/traces");
  assert.equal(
    request.headers.authorization,
    "Basic " + Buffer.from("pk-test:sk-test").toString("base64"),
  );
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const data = Buffer.concat(chunks);
  batches.push(
    JSON.parse(
      (request.headers["content-encoding"] === "gzip"
        ? gunzipSync(data)
        : data
      ).toString("utf8"),
    ),
  );
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
  const agent = new Agent({
    id: "consumer",
    instructions: "A visible system prompt.",
    model: new ScriptedProvider([
      {
        text: "built trace answer",
        usage: { inputTokens: 3, outputTokens: 2 },
      },
      { text: "first Session answer" },
      { text: "second Session answer" },
    ]),
  });
  const controller = new Controller({
    id: "consumer-tracing",
    agent,
    plugins: [
      new OpenTelemetryPlugin({
        realtime: true,
        adapters: [
          new LangfuseAdapter({
            publicKey: "pk-test",
            secretKey: "sk-test",
            baseUrl: `http://127.0.0.1:${address.port}`,
          }),
        ],
      }),
    ],
  });
  try {
    await controller.initialize();
    assert.equal((await agent.generate("hello")).status, "completed");
    const session = await controller.createSession({
      threadId: "built-thread",
    });
    for (const text of ["first question", "second question"]) {
      const done = new Promise<void>((resolve, reject) => {
        const stop = session.subscribe((event) => {
          if (event.type === "stream.end") {
            stop();
            resolve();
          }
          if (event.type === "stream.error") {
            stop();
            reject(Error(event.payload.error.message));
          }
        });
      });
      await session.followUp(text);
      await done;
    }
  } finally {
    await controller.dispose();
  }
  assert.ok(batches.length > 0);
  const exported = JSON.stringify(batches);
  assert.ok(exported.includes("built trace answer"));
  assert.ok(exported.includes("langfuse.observation.usage_details"));
  assert.ok(!exported.includes("sk-test"));
  type Payload = {
    resourceSpans: {
      scopeSpans: {
        spans: {
          name: string;
          traceId: string;
          spanId: string;
          parentSpanId?: string;
          attributes: { key: string; value: { stringValue?: string } }[];
        }[];
      }[];
    }[];
  };
  const spans = (batches as Payload[]).flatMap((batch) =>
    batch.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    ),
  );
  assert.equal(new Set(spans.map((span) => span.traceId)).size, 3);
  assert.equal(spans.filter((span) => span.name === "consumer").length, 3);
  const secondTurn = spans.find((span) => span.name === "turn 2")!;
  assert.ok(secondTurn);
  const root = spans.find((span) => span.spanId === secondTurn.parentSpanId)!;
  assert.equal(root.name, "consumer");
  assert.equal(root.traceId, secondTurn.traceId);
  assert.equal(new Set(spans.map((span) => span.spanId)).size, spans.length);
  const read = (span: (typeof spans)[number], key: string) =>
    span.attributes.find((attribute) => attribute.key === key)?.value
      .stringValue;
  assert.equal(read(root, "session.id"), "built-thread");
  assert.ok(spans.some((span) =>
    span.name === "turn 1" && span.traceId !== root.traceId &&
    read(span, "session.id") === "built-thread",
  ));
  const standalone = spans.find((span) => span.name === "consumer" && !read(span, "session.id"));
  assert.ok(standalone);
  const generations = spans.filter(
    (span) => read(span, "tessar.observation.type") === "generation",
  );
  assert.equal(generations.length, 3);
  for (const span of generations) {
    const displayed = JSON.parse(read(span, "langfuse.observation.input")!);
    assert.deepEqual(displayed.messages[0], {
      role: "system",
      content: [{ type: "text", text: "A visible system prompt." }],
    });
    assert.ok(!Object.hasOwn(displayed, "instructions"));
    const original = JSON.parse(read(span, "tessar.input")!);
    assert.equal(original.messages[0].role, "user");
    assert.equal(
      original.instructions.sections[0].content,
      "A visible system prompt.",
    );
  }
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
