import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { AgentHarness } from "@tessar/core/testing";
import { OpenTelemetryPlugin, LangfuseAdapter } from "../src/index.js";

it.each([
  { status: 200, sessionMode: false },
  { status: 401, sessionMode: false },
  { status: 200, sessionMode: true },
  { status: 401, sessionMode: true },
].flatMap((scenario) => [false, true].map((realtime) => ({ ...scenario, realtime }))))(
  "exports through the standard OTLP SDK with HTTP $status, session=$sessionMode and realtime=$realtime without failing execution",
  async ({ status, sessionMode, realtime }) => {
    const received: {
      path?: string;
      authorization?: string;
      version?: string;
      body: unknown;
    }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const data = Buffer.concat(chunks);
      received.push({
        path: request.url,
        authorization: request.headers.authorization,
        version: request.headers["x-langfuse-ingestion-version"] as
          | string
          | undefined,
        body: JSON.parse(
          (request.headers["content-encoding"] === "gzip"
            ? gunzipSync(data)
            : data
          ).toString("utf8"),
        ),
      });
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw Error("Missing collector address");
      const harness = await AgentHarness.create({
        modelScripts: [
          {
            text: "offline answer",
            usage: { inputTokens: 3, outputTokens: 2 },
          },
          { text: "second answer", usage: { inputTokens: 6, outputTokens: 2 } },
        ],
        plugins: [
          new OpenTelemetryPlugin({
            realtime,
            adapters: [
              new LangfuseAdapter({
                publicKey: "pk-lf-test",
                secretKey: "sk-lf-test",
                baseUrl: `http://127.0.0.1:${address.port}`,
              }),
            ],
            traceName: "wire test",
            tags: ["sdk-test"],
          }),
        ],
      });
      try {
        if (sessionMode) {
          const session = await harness.controller.createSession({
            threadId: "wire-conversation",
            model: harness.provider.ref,
          });
          for (const text of ["hello", "hello again"]) {
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
        } else
          expect(
            (
              await harness.agent.generate("hello", {
                model: harness.provider.ref,
              })
            ).status,
          ).toBe("completed");
      } finally {
        await harness.dispose();
      }
      expect(received.length).toBeGreaterThan(0);
      const exported = received.find(
        (request) => request.path === "/api/public/otel/v1/traces",
      )!;
      expect(exported.authorization).toBe(
        "Basic " + Buffer.from("pk-lf-test:sk-lf-test").toString("base64"),
      );
      expect(exported.version).toBe("4");
      const body = JSON.stringify(exported.body);
      expect(body).toContain("offline answer");
      expect(body).toContain("langfuse.observation.usage_details");
      expect(body).not.toContain("sk-lf-test");
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
      const spans = received.flatMap((request) =>
        (request.body as Payload).resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) => scope.spans),
        ),
      );
      const turn = spans.find((span) => span.name === "turn 1")!;
      expect(turn).toBeDefined();
      const read = (key: string) =>
        JSON.parse(
          turn.attributes.find((attribute) => attribute.key === key)!.value
            .stringValue!,
        );
      expect(
        read("langfuse.observation.input").messages[0].content[0].text,
      ).toBe("hello");
      expect(read("langfuse.observation.output")[0].content[0].text).toBe(
        "offline answer",
      );
      expect(
        spans.every(
          (span) =>
            span.attributes.find(
              (attribute) => attribute.key === "langfuse.trace.name",
            )?.value.stringValue === "wire test",
        ),
      ).toBe(true);
      if (sessionMode) {
        const roots = spans.filter((span) => span.name === "test-agent");
        const turns = spans.filter((span) => span.name.startsWith("turn "));
        expect(roots).toHaveLength(2);
        expect(new Set(spans.map((span) => span.traceId)).size).toBe(2);
        expect(spans.every((span) => span.attributes.find((attribute) => attribute.key === "session.id")?.value.stringValue === "wire-conversation")).toBe(true);
        expect(turns.map((span) => span.name).sort()).toEqual([
          "turn 1",
          "turn 2",
        ]);
        expect(
          turns.every((span) => roots.some((root) => span.parentSpanId === root.spanId && span.traceId === root.traceId)),
        ).toBe(true);
        expect(new Set(spans.map((span) => span.spanId)).size).toBe(
          spans.length,
        );
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
