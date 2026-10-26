import { expect, it } from "vitest";
import { z } from "zod";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { AssistantMessage, MessageCodec, createTool } from "@tessar/core";
import { AgentHarness } from "@tessar/core/testing";
import {
  OpenTelemetryPlugin,
  OTLPAdapter,
  LangfuseAdapter,
  LaminarAdapter,
} from "../src/index.js";

const decode = (span: ReadableSpan, key: string) => {
  const value = span.attributes[key];
  return typeof value === "string" ? JSON.parse(value) : value;
};

it("maps sequential tool calls, structured results and definitions without moving tools between Turns", async () => {
  const captured: ReadableSpan[][] = [];
  function capture(Base: typeof OTLPAdapter) {
    return new (class extends Base {
      override createExporter(): SpanExporter {
        const spans: ReadableSpan[] = [];
        captured.push(spans);
        return {
          export: (batch, done) => {
            spans.push(...batch.map((span) => this.mapSpan(span)));
            done({ code: 0 });
          },
          async shutdown() {},
        };
      }
    })();
  }
  // Constructors differ; these local subclasses supply only test credentials.
  class Langfuse extends LangfuseAdapter {
    constructor() { super({ publicKey: "pk", secretKey: "sk" }); }
  }
  class Laminar extends LaminarAdapter {
    constructor() { super({ apiKey: "key" }); }
  }
  const time = createTool({
    name: "get_current_time",
    description: "Get the current date",
    schema: z.object({}),
    execute: () => ({ date: "2026-10-23" }),
  });
  const weather = createTool({
    name: "get_weather",
    description: "Get weather for a date",
    schema: z.object({ date: z.string() }),
    execute: ({ date }) => ({ date, temperature: 30 }),
  });
  const response = (name: string, toolCallId: string, args: Record<string, string>) => ({
    response: {
      message: MessageCodec.encode(new AssistantMessage([
        { type: "reasoning", text: "Use the next tool." },
        { type: "tool-call", name, toolCallId, arguments: args },
      ])),
    },
  });
  const harness = await AgentHarness.create({
    tools: { get_current_time: time, get_weather: weather },
    modelScripts: [
      response("get_current_time", "time-call", {}),
      response("get_weather", "weather-call", { date: "2026-10-23" }),
      { text: "Today is 30 degrees." },
    ],
    plugins: [new OpenTelemetryPlugin({
      adapters: [capture(OTLPAdapter), capture(Langfuse), capture(Laminar)],
    })],
  });
  try {
    expect((await harness.agent.generate("Weather today?")).status).toBe("completed");
  } finally {
    await harness.dispose();
  }
  const [generic, langfuse, laminar] = captured;
  for (const spans of captured) {
    const turns = [1, 2, 3].map((n) => spans.find((span) => span.name === `turn ${n}`)!);
    expect(turns.every(Boolean)).toBe(true);
    for (const [index, name] of ["get_current_time", "get_weather"].entries()) {
      const tool = spans.find((span) => span.name === name)!;
      expect(tool.parentSpanContext?.spanId).toBe(turns[index]!.spanContext().spanId);
    }
  }
  const generations = (spans: ReadableSpan[]) => spans.filter((span) =>
    span.attributes["tessar.observation.type"] === "generation");
  const first = generations(generic!)[0]!;
  const final = generations(generic!).at(-1)!;
  const definitions = harness.provider.calls[0]!.tools;
  expect(decode(first, "gen_ai.tool.definitions")).toEqual(definitions.map((tool) => ({
    type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema,
  })));
  expect(decode(final, "gen_ai.input.messages")[2].parts[0].response).toEqual({ date: "2026-10-23" });

  const lmFirst = generations(laminar!)[0]!;
  const lmFinal = generations(laminar!).at(-1)!;
  expect(decode(lmFirst, "lmnr.span.output")[0].parts[1]).toEqual({
    type: "tool_call", id: "time-call", name: "get_current_time", arguments: {},
  });
  const lmInput = decode(lmFinal, "lmnr.span.input");
  expect(lmInput[2].parts[0]).toEqual({ type: "tool_call_response", id: "time-call", result: { date: "2026-10-23" } });
  expect(lmInput[4].parts[0]).toEqual({ type: "tool_call_response", id: "weather-call", result: { date: "2026-10-23", temperature: 30 } });
  const lmTool = laminar!.find(span => span.name === "get_weather")!;
  expect(lmTool.attributes["gen_ai.tool.description"]).toBe(weather.description);
  expect(decode(lmTool, "tessar.metadata.toolParameters")).toEqual(weather.jsonSchema);
  expect(decode(lmTool, "lmnr.span.output")).toEqual({ date: "2026-10-23", temperature: 30 });

  const lfTool = langfuse!.find(span => span.name === "get_weather")!;
  expect(decode(lfTool, "langfuse.observation.metadata.toolDescription")).toBe(weather.description);
  expect(decode(lfTool, "langfuse.observation.metadata.toolParameters")).toEqual(weather.jsonSchema);
  // Display mappings must never mutate the requests seen by the provider.
  expect(decode(final, "tessar.input")).toEqual(harness.provider.calls.at(-1));
});
