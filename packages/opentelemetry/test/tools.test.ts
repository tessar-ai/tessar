import { expect, it } from "vitest";
import { z } from "zod";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { AssistantMessage, MessageCodec, createTool } from "@tessar/core";
import { AgentHarness } from "@tessar/core/testing";
import {
  OpenTelemetryPlugin,
  OTLPAdapter,
  LangfuseAdapter,
  ArizeAdapter,
  TraceloopAdapter,
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
  class Arize extends ArizeAdapter {
    constructor() { super({ apiKey: "key", spaceId: "space", projectName: "test" }); }
  }
  class Traceloop extends TraceloopAdapter {
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
      adapters: [capture(OTLPAdapter), capture(Langfuse), capture(Arize), capture(Traceloop)],
    })],
  });
  try {
    expect((await harness.agent.generate("Weather today?")).status).toBe("completed");
  } finally {
    await harness.dispose();
  }
  const [generic, langfuse, arize, traceloop] = captured;
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

  const aiFirst = generations(arize!)[0]!;
  const aiFinal = generations(arize!).at(-1)!;
  expect(aiFirst.attributes["llm.output_messages.0.message.tool_calls.0.tool_call.function.name"]).toBe("get_current_time");
  expect(aiFirst.attributes["llm.output_messages.0.message.tool_calls.0.tool_call.id"]).toBe("time-call");
  // AX accepts conventional tool_calls; unsupported ordered tool_use contents
  // otherwise arrive as an empty block with their call fields stranded in metadata.
  expect(aiFirst.attributes["llm.output_messages.0.message.contents.1.message_content.type"]).toBeUndefined();
  expect(aiFirst.attributes["output.mime_type"]).toBe("text/plain");
  expect(aiFirst.attributes["output.value"]).toContain("[Tool call: get_current_time]");
  expect(aiFinal.attributes["input.value"]).toContain('TOOL\n{"date":"2026-10-23"}');
  expect(aiFinal.attributes["input.value"]).toContain('TOOL\n{"date":"2026-10-23","temperature":30}');
  expect(aiFinal.attributes["llm.input_messages.2.message.tool_call_id"]).toBe("time-call");
  expect(decode(aiFinal, "llm.input_messages.2.message.content")).toEqual({ date: "2026-10-23" });
  expect(aiFinal.attributes["llm.input_messages.2.message.contents.0.message_content.type"]).toBe("text");
  expect(aiFirst.attributes["llm.tools.1.tool.name"]).toBe("get_weather");
  expect(decode(aiFirst, "llm.tools.1.tool.json_schema")).toEqual(weather.jsonSchema);
  const aiTool = arize!.find((span) => span.name === "get_weather")!;
  expect(aiTool.attributes["tool.description"]).toBe(weather.description);
  expect(decode(aiTool, "tool.parameters")).toEqual(weather.jsonSchema);
  expect(decode(aiTool, "gen_ai.tool.call.result")).toEqual({ date: "2026-10-23", temperature: 30 });

  const tlFirst = generations(traceloop!)[0]!;
  const tlFinal = generations(traceloop!).at(-1)!;
  expect(tlFirst.attributes["gen_ai.completion.0.tool_calls.0.name"]).toBe("get_current_time");
  expect(tlFirst.attributes["gen_ai.completion.0.tool_calls.0.id"]).toBe("time-call");
  expect(tlFinal.attributes["gen_ai.prompt.2.tool_call_id"]).toBe("time-call");
  expect(decode(tlFinal, "gen_ai.prompt.2.content")).toEqual({ date: "2026-10-23" });
  expect(decode(tlFinal, "gen_ai.input.messages")[2].parts[0].response).toBe('{"date":"2026-10-23"}');
  for (const [spans, prefix] of [
    [langfuse!, "langfuse.observation.metadata."],
    [traceloop!, "traceloop.association.properties."],
  ] as const) {
    const tool = spans.find((span) => span.name === "get_weather")!;
    expect(decode(tool, prefix + "toolDescription")).toBe(weather.description);
    expect(decode(tool, prefix + "toolParameters")).toEqual(weather.jsonSchema);
  }
  // Display mappings must never mutate the requests seen by the provider.
  expect(decode(final, "tessar.input")).toEqual(harness.provider.calls.at(-1));
});
