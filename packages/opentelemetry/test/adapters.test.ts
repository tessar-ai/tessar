import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AssistantMessage,
  Agent,
  Controller,
  MessageCodec,
  buildInstruction,
  createTool,
} from "@tessar/core";
import { AgentHarness, ScriptedProvider } from "@tessar/core/testing";
import {
  OpenTelemetryPlugin,
  OTLPAdapter,
  LangfuseAdapter,
  LaminarAdapter,
  type TraceAdapter,
} from "../src/index.js";

type Attribute = {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string | number;
    arrayValue?: unknown;
  };
};
type WireSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Attribute[];
};
type Payload = {
  resourceSpans: {
    resource: { attributes: Attribute[] };
    scopeSpans: { spans: WireSpan[] }[];
  }[];
};
const read = (attributes: Attribute[], key: string) => {
  const value = attributes.find((attribute) => attribute.key === key)?.value;
  return (
    value?.stringValue ??
    (value?.intValue === undefined ? undefined : Number(value.intValue))
  );
};

it("exports one shared trace through all three adapters without mixing their mappings", async () => {
  const received = new Map<
    string,
    {
      headers: Record<string, string | string[] | undefined>;
      payloads: Payload[];
    }
  >();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const payload = JSON.parse(
      (request.headers["content-encoding"] === "gzip"
        ? gunzipSync(raw)
        : raw
      ).toString(),
    ) as Payload;
    const entry = received.get(request.url!) ?? {
      headers: request.headers,
      payloads: [],
    };
    entry.payloads.push(payload);
    received.set(request.url!, entry);
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("No collector address");
    const base = `http://127.0.0.1:${address.port}`;
    const weather = createTool({
      name: "weather",
      description: "Weather",
      schema: z.object({}),
      execute: () => ({ condition: "sunny" }),
    });
    const harness = await AgentHarness.create({
      instructions: "You are a weather assistant.",
      tools: { weather },
      modelScripts: [
        {
          response: {
            message: MessageCodec.encode(
              new AssistantMessage([
                { type: "reasoning", text: "Check the weather tool." },
                {
                  type: "tool-call",
                  toolCallId: "weather-call",
                  name: "weather",
                  arguments: {},
                },
              ]),
            ),
          },
        },
        {
          text: "It is sunny",
          response: {
            message: MessageCodec.encode(
              new AssistantMessage([
                { type: "reasoning", text: "The tool reported sunny weather." },
                { type: "text", text: "It is sunny" },
              ]),
            ),
          },
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 40,
            cacheWriteInputTokens: 10,
            reasoningOutputTokens: 5,
          },
        },
      ],
      plugins: [
        new OpenTelemetryPlugin({
          serviceName: "adapter-test",
          traceName: "weather conversation",
          tags: ["weather"],
          adapters: [
            new OTLPAdapter({
              endpoint: base + "/generic/v1/traces",
              headers: { Authorization: "Bearer generic-key" },
            }),
            new LangfuseAdapter({
              baseUrl: base,
              publicKey: "pk-test",
              secretKey: "sk-test",
              prompt: { name: "weather-system", version: 2 },
            }),
            new LaminarAdapter({
              endpoint: base + "/laminar/v1/traces",
              apiKey: "laminar-test",
            }),
          ],
        }),
        {
          id: "dynamic-instructions",
          setup(tessar) {
            tessar.hook("context.prepare", (event) => ({
              ...event.payload,
              instructions: buildInstruction([
                { id: "memory", content: "Use Celsius.", order: 10 },
                ...event.payload.instructions.sections,
              ]),
            }));
          },
        },
      ],
    });
    try {
      expect(
        (
          await harness.agent.generate("Weather?", {
            model: harness.provider.ref,
          })
        ).status,
      ).toBe("completed");
    } finally {
      await harness.dispose();
    }

    const spans = (path: string) =>
      received
        .get(path)!
        .payloads.flatMap((payload) =>
          payload.resourceSpans.flatMap((resource) =>
            resource.scopeSpans.flatMap((scope) => scope.spans),
          ),
        );
    const generic = spans("/generic/v1/traces"),
      langfuse = spans("/api/public/otel/v1/traces"),
      laminar = spans("/laminar/v1/traces");
    expect(generic.length).toBeGreaterThan(0);
    const ids = (values: WireSpan[]) =>
      values.map((span) => span.traceId + ":" + span.spanId).sort();
    expect(ids(langfuse)).toEqual(ids(generic));
    expect(ids(laminar)).toEqual(ids(generic));
    expect(new Set(generic.map((span) => span.traceId)).size).toBe(1);
    expect(JSON.stringify(generic)).not.toContain("langfuse.");
    expect(JSON.stringify(generic)).not.toContain("lmnr.");
    expect(JSON.stringify(langfuse)).not.toContain("lmnr.");
    expect(JSON.stringify(laminar)).not.toContain("langfuse.");

    const generation = generic.find(
      (span) => read(span.attributes, "gen_ai.usage.input_tokens") === 100,
    )!;
    expect(read(generation.attributes, "gen_ai.usage.output_tokens")).toBe(20);
    expect(
      read(generation.attributes, "gen_ai.usage.cache_read.input_tokens"),
    ).toBe(40);
    expect(read(generation.attributes, "gen_ai.request.model")).toBe("test");
    expect(read(generation.attributes, "gen_ai.operation.name")).toBe("chat");
    expect(
      JSON.parse(
        String(read(generation.attributes, "gen_ai.system_instructions")),
      ),
    ).toEqual([
      { type: "text", content: "You are a weather assistant." },
      { type: "text", content: "Use Celsius." },
    ]);
    const rawRequest = JSON.parse(
      String(read(generation.attributes, "tessar.input")),
    );
    expect(rawRequest).toEqual(harness.provider.calls.at(-1));
    expect(rawRequest.messages[0].role).toBe("user");
    expect(
      rawRequest.instructions.sections.map(
        (section: { content: string }) => section.content,
      ),
    ).toEqual(["You are a weather assistant.", "Use Celsius."]);
    expect(read(generation.attributes, "gen_ai.output.messages")).toBeDefined();
    expect(
      JSON.parse(String(read(generation.attributes, "gen_ai.output.messages"))),
    ).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "reasoning", content: "The tool reported sunny weather." },
          { type: "text", content: "It is sunny" },
        ],
      },
    ]);
    const input = JSON.parse(
      String(read(generation.attributes, "gen_ai.input.messages")),
    );
    expect(input.map((message: { role: string }) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(input[1].parts).toEqual([
      { type: "reasoning", content: "Check the weather tool." },
      { type: "tool_call", id: "weather-call", name: "weather", arguments: {} },
    ]);
    expect(input[2].parts).toEqual([
      { type: "tool_call_response", id: "weather-call", response: { condition: "sunny" } },
    ]);
    const lfGeneration = langfuse.find(
      (span) => span.spanId === generation.spanId,
    )!;
    const lfInput = JSON.parse(
      String(read(lfGeneration.attributes, "langfuse.observation.input")),
    );
    expect(lfInput.messages[0]).toEqual({
      role: "system",
      content: [
        { type: "text", text: "You are a weather assistant.\n\nUse Celsius." },
      ],
    });
    expect(lfInput.messages.slice(1)).toEqual(rawRequest.messages);
    expect(lfInput).not.toHaveProperty("instructions");
    expect(
      JSON.parse(
        String(
          read(lfGeneration.attributes, "langfuse.observation.usage_details"),
        ),
      ),
    ).toEqual({
      input: 50,
      input_cached_tokens: 40,
      input_cache_write: 10,
      output: 15,
      output_reasoning_tokens: 5,
      total: 120,
    });
    expect(
      read(lfGeneration.attributes, "langfuse.observation.prompt.name"),
    ).toBe("weather-system");
    expect(
      read(
        lfGeneration.attributes,
        "langfuse.observation.completion_start_time",
      ),
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(
      langfuse.every(
        (span) =>
          read(span.attributes, "langfuse.trace.name") ===
          "weather conversation",
      ),
    ).toBe(true);
    const lmGeneration = laminar.find(span => span.spanId === generation.spanId)!;
    expect(read(lmGeneration.attributes, "lmnr.span.type")).toBe("LLM");
    expect(read(lmGeneration.attributes, "gen_ai.system")).toBe("scripted");
    expect(read(lmGeneration.attributes, "llm.usage.total_tokens")).toBe(120);
    expect(read(lmGeneration.attributes, "gen_ai.usage.reasoning_tokens")).toBe(5);
    const lmInput = JSON.parse(String(read(lmGeneration.attributes, "lmnr.span.input")));
    expect(lmInput.map((message: { role: string }) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(lmInput[0].parts[0]).toEqual({ type: "text", content: "You are a weather assistant.\n\nUse Celsius." });
    expect(lmInput[3].parts[0]).toEqual({ type: "tool_call_response", id: "weather-call", result: { condition: "sunny" } });
    expect(JSON.parse(String(read(lmGeneration.attributes, "lmnr.span.output")))[0].parts).toEqual([
      { type: "thinking", content: "The tool reported sunny weather." },
      { type: "text", content: "It is sunny" },
    ]);
    const lmTurn = laminar.find(span => span.name === "turn 2")!;
    expect(read(lmTurn.attributes, "lmnr.span.type")).toBe("DEFAULT");
    expect(JSON.parse(String(read(lmTurn.attributes, "lmnr.span.input")))[0]).toEqual({
      role: "system", content: [{ type: "text", text: "You are a weather assistant.\n\nUse Celsius." }],
    });
    expect(JSON.parse(String(read(lmTurn.attributes, "lmnr.span.output")))).toEqual([
      { role: "assistant", content: [
        { type: "reasoning", text: "The tool reported sunny weather." },
        { type: "text", text: "It is sunny" },
      ] },
    ]);
    expect(laminar.some(span => read(span.attributes, "lmnr.span.type") === "TOOL")).toBe(true);
    const lmResource = received.get("/laminar/v1/traces")!.payloads[0]!.resourceSpans[0]!.resource.attributes;
    expect(read(lmResource, "service.name")).toBe("adapter-test");
    const genericResource =
      received.get("/generic/v1/traces")!.payloads[0]!.resourceSpans[0]!
        .resource.attributes;
    expect(read(genericResource, "lmnr.association.properties.metadata.project")).toBeUndefined();
    expect(received.get("/generic/v1/traces")!.headers.authorization).toBe(
      "Bearer generic-key",
    );
    expect(
      received.get("/api/public/otel/v1/traces")!.headers.authorization,
    ).toBe("Basic " + Buffer.from("pk-test:sk-test").toString("base64"));
    expect(
      received.get("/api/public/otel/v1/traces")!.headers[
        "x-langfuse-ingestion-version"
      ],
    ).toBe("4");
    expect(received.get("/laminar/v1/traces")!.headers.authorization).toBe(
      "Bearer laminar-test",
    );
    expect(
      JSON.parse(
        String(read(lfGeneration.attributes, "langfuse.observation.output")),
      ),
    ).toEqual(JSON.parse(String(read(generation.attributes, "tessar.output"))));
    expect(
      JSON.stringify([...received.values()].map((value) => value.payloads)),
    ).not.toContain("sk-test");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it.each([false, true])("closes exporters created before a setup failure with realtime=%s", async (realtime) => {
  expect(() => new OpenTelemetryPlugin({ adapters: [] })).toThrow(/adapter/i);
  let closed = false;
  class CaptureAdapter implements TraceAdapter {
    createExporter() {
      return {
        export(_spans: unknown[], done: (result: { code: number }) => void) {
          done({ code: 0 });
        },
        async shutdown() {
          closed = true;
        },
      };
    }
  }
  class BrokenAdapter implements TraceAdapter {
    createExporter(): never {
      throw Error("adapter setup failed");
    }
  }
  const agent = new Agent({ id: "adapter-setup-agent", model: new ScriptedProvider([]) });
  const controller = new Controller({
    id: "adapter-setup-controller", agent,
    plugins: [new OpenTelemetryPlugin({
      realtime, adapters: [new CaptureAdapter(), new BrokenAdapter()],
    })],
  });
  try {
    await expect(controller.initialize()).rejects.toThrow("adapter setup failed");
  } finally { await controller.dispose(); }
  expect(closed).toBe(true);
});

it("requires keys for authenticated adapters and validates OTLP endpoint schemes", () => {
  for (const name of [
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "LMNR_PROJECT_API_KEY",
  ])
    vi.stubEnv(name, undefined);
  try {
    expect(() => new LangfuseAdapter()).toThrow(/requires/);
    expect(() => new LaminarAdapter()).toThrow(/requires/);
    expect(() => new OTLPAdapter({ endpoint: "file:///trace" })).toThrow(
      /HTTP/,
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
