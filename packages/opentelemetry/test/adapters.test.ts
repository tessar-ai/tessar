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
  ArizeAdapter,
  TraceloopAdapter,
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

it("exports one shared trace through all four adapters without mixing their mappings", async () => {
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
            new ArizeAdapter({
              endpoint: base + "/arize/v1/traces",
              apiKey: "arize-test",
              spaceId: "test-space",
              projectName: "test-project",
            }),
            new TraceloopAdapter({
              endpoint: base + "/traceloop/v1/traces",
              apiKey: "traceloop-test",
            }),
          ],
        }),
        {
          id: "dynamic-instructions",
          setup(tessar) {
            tessar.hook("model.request", (event) => ({
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
      arize = spans("/arize/v1/traces");
    const traceloop = spans("/traceloop/v1/traces");
    expect(generic.length).toBeGreaterThan(0);
    const ids = (values: WireSpan[]) =>
      values.map((span) => span.traceId + ":" + span.spanId).sort();
    expect(ids(langfuse)).toEqual(ids(generic));
    expect(ids(arize)).toEqual(ids(generic));
    expect(ids(traceloop)).toEqual(ids(generic));
    expect(new Set(generic.map((span) => span.traceId)).size).toBe(1);
    expect(JSON.stringify(generic)).not.toContain("langfuse.");
    expect(JSON.stringify(generic)).not.toContain("openinference.");
    expect(JSON.stringify(generic)).not.toContain("traceloop.");
    expect(JSON.stringify(langfuse)).not.toContain("openinference.");
    expect(JSON.stringify(arize)).not.toContain("langfuse.");

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
    const arizeGeneration = arize.find(
      (span) => span.spanId === generation.spanId,
    )!;
    expect(read(arizeGeneration.attributes, "input.mime_type")).toBe("text/plain");
    expect(read(arizeGeneration.attributes, "input.value")).toContain(
      "SYSTEM\nYou are a weather assistant.\n\nUse Celsius.",
    );
    expect(read(arizeGeneration.attributes, "input.value")).toContain(
      'TOOL\n{"condition":"sunny"}',
    );
    expect(read(arizeGeneration.attributes, "output.value")).toBe(
      "ASSISTANT\n[Thinking]\nThe tool reported sunny weather.\nIt is sunny",
    );
    for (const key of ["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.system_instructions", "gen_ai.tool.definitions"])
      expect(read(arizeGeneration.attributes, key)).toBeUndefined();
    expect(read(arizeGeneration.attributes, "openinference.span.kind")).toBe(
      "LLM",
    );
    expect(read(arizeGeneration.attributes, "llm.token_count.prompt")).toBe(
      100,
    );
    expect(
      read(arizeGeneration.attributes, "llm.input_messages.0.message.role"),
    ).toBe("system");
    expect(
      read(arizeGeneration.attributes, "llm.input_messages.0.message.content"),
    ).toBe("You are a weather assistant.\n\nUse Celsius.");
    expect(
      read(arizeGeneration.attributes, "llm.input_messages.1.message.role"),
    ).toBe("user");
    expect(
      read(arizeGeneration.attributes, "llm.output_messages.0.message.content"),
    ).toBe("It is sunny");
    expect(
      read(
        arizeGeneration.attributes,
        "llm.output_messages.0.message.contents.0.message_content.type",
      ),
    ).toBe("reasoning");
    expect(
      read(
        arizeGeneration.attributes,
        "llm.output_messages.0.message.contents.0.message_content.text",
      ),
    ).toBe("The tool reported sunny weather.");
    expect(
      read(
        arizeGeneration.attributes,
        "llm.output_messages.0.message.contents.1.message_content.type",
      ),
    ).toBe("text");
    const arizeTurn = arize.find((span) => span.name === "turn 2")!;
    expect(read(arizeTurn.attributes, "openinference.span.kind")).toBe("CHAIN");
    expect(read(arizeTurn.attributes, "output.mime_type")).toBe("text/plain");
    expect(read(arizeTurn.attributes, "output.value")).toBe(
      "ASSISTANT\n[Thinking]\nThe tool reported sunny weather.\nIt is sunny",
    );
    expect(read(arizeTurn.attributes, "input.mime_type")).toBe("text/plain");
    expect(read(arizeTurn.attributes, "input.value")).toContain(
      "SYSTEM\nYou are a weather assistant.\n\nUse Celsius.",
    );
    expect(
      JSON.parse(String(read(arizeTurn.attributes, "tessar.output"))),
    ).toEqual([
      JSON.parse(String(read(generation.attributes, "tessar.output"))),
    ]);
    expect(
      arize.some(
        (span) => read(span.attributes, "openinference.span.kind") === "TOOL",
      ),
    ).toBe(true);
    const arizeResource =
      received.get("/arize/v1/traces")!.payloads[0]!.resourceSpans[0]!.resource
        .attributes;
    expect(read(arizeResource, "openinference.project.name")).toBe(
      "test-project",
    );
    expect(read(arizeResource, "service.name")).toBe("adapter-test");
    const genericResource =
      received.get("/generic/v1/traces")!.payloads[0]!.resourceSpans[0]!
        .resource.attributes;
    expect(read(genericResource, "openinference.project.name")).toBeUndefined();
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
    expect(received.get("/arize/v1/traces")!.headers.authorization).toBe(
      "arize-test",
    );
    expect(received.get("/arize/v1/traces")!.headers["arize-space-id"]).toBe(
      "test-space",
    );
    expect(received.get("/traceloop/v1/traces")!.headers.authorization).toBe(
      "Bearer traceloop-test",
    );
    const tlGeneration = traceloop.find(
      (span) => span.spanId === generation.spanId,
    )!;
    expect(read(tlGeneration.attributes, "llm.request.type")).toBe("chat");
    expect(read(tlGeneration.attributes, "gen_ai.usage.prompt_tokens")).toBe(
      100,
    );
    expect(read(tlGeneration.attributes, "gen_ai.prompt.0.role")).toBe(
      "system",
    );
    expect(read(tlGeneration.attributes, "gen_ai.prompt.0.content")).toBe(
      "You are a weather assistant.\n\nUse Celsius.",
    );
    expect(read(tlGeneration.attributes, "gen_ai.prompt.1.role")).toBe("user");
    expect(read(tlGeneration.attributes, "gen_ai.prompt.3.tool_call_id")).toBe("weather-call");
    expect(read(tlGeneration.attributes, "gen_ai.prompt.3.content")).toBe('{"condition":"sunny"}');
    expect(read(tlGeneration.attributes, "gen_ai.completion.0.content")).toBe(
      "It is sunny",
    );
    expect(read(tlGeneration.attributes, "gen_ai.output.messages")).toBe(
      read(generation.attributes, "gen_ai.output.messages"),
    );
    expect(
      JSON.parse(
        String(read(lfGeneration.attributes, "langfuse.observation.output")),
      ),
    ).toEqual(JSON.parse(String(read(generation.attributes, "tessar.output"))));
    expect(
      traceloop.some(
        (span) => read(span.attributes, "traceloop.span.kind") === "tool",
      ),
    ).toBe(true);
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
    "ARIZE_API_KEY",
    "ARIZE_SPACE_ID",
    "ARIZE_PROJECT_NAME",
    "TRACELOOP_API_KEY",
  ])
    vi.stubEnv(name, undefined);
  try {
    expect(() => new LangfuseAdapter()).toThrow(/requires/);
    expect(() => new ArizeAdapter()).toThrow(/requires/);
    expect(() => new TraceloopAdapter()).toThrow(/requires/);
    expect(() => new OTLPAdapter({ endpoint: "file:///trace" })).toThrow(
      /HTTP/,
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
