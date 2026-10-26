import { expect, it } from "vitest";
import { z } from "zod";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { AssistantMessage, MessageCodec, buildInstruction, createTool } from "@tessar/core";
import { AgentHarness } from "@tessar/core/testing";
import { LaminarAdapter, OpenTelemetryPlugin } from "../src/index.js";

class CaptureLaminar extends LaminarAdapter {
  readonly spans: ReadableSpan[] = [];
  constructor() { super({ apiKey: "test" }); }
  override createExporter() {
    return {
      export: (spans: ReadableSpan[], done: (result: { code: number }) => void) => {
        this.spans.push(...spans.map(span => this.mapSpan(span)));
        done({ code: 0 });
      },
      shutdown: async () => {},
    };
  }
}
const read = (span: ReadableSpan, key: string) => JSON.parse(String(span.attributes[key]));

it("maps Laminar conversations with effective System instructions, typed thinking and correlated tool results", async () => {
  const adapter = new CaptureLaminar();
  let requestNumber = 0;
  const h = await AgentHarness.create({
    instructions: "Use the weather tool.",
    tools: { weather: createTool({ name: "weather", description: "Get weather", schema: z.object({}), execute: () => ({ temperature: 30 }) }) },
    modelScripts: [{ response: { message: MessageCodec.encode(new AssistantMessage([
      { type: "reasoning", text: "Check first." },
      { type: "tool-call", name: "weather", toolCallId: "weather-1", arguments: {} },
      { type: "text", text: "Checking." },
    ])) } }, { text: "It is 30 degrees." }, { text: "Bring water." }, { text: "New conversation." }],
    plugins: [new OpenTelemetryPlugin({ realtime: true, tags: ["laminar-test"], adapters: [adapter] }), {
      id: "prepared-instructions",
      setup(tessar) {
        tessar.hook("model.request", event => ({ ...event.payload,
          instructions: buildInstruction([{ id: "prepared", content: `Prepared request ${++requestNumber}` }]),
        }));
      },
    }],
  });
  const session = await h.controller.createSession({ threadId: "laminar-first" });
  const ask = async (text: string) => {
    let stop = () => {};
    const done = new Promise<void>((resolve, reject) => {
      stop = session.subscribe(event => {
        if (event.type === "stream.end") resolve();
        if (event.type === "stream.error") reject(Error(event.payload.error.message));
      });
    });
    try { await Promise.all([session.followUp(text), done]); }
    finally { stop(); }
  };
  try {
    await ask("Check weather.");
    await ask("Any advice?");
    await session.thread.create({ id: "laminar-second" });
    await ask("Start fresh.");
  } finally { await h.dispose(); }

  const { spans } = adapter;
  const roots = spans.filter(span => span.attributes["lmnr.span.type"] === "EXECUTOR");
  expect(roots).toHaveLength(3);
  expect(new Set(roots.map(span => span.spanContext().traceId)).size).toBe(3);
  expect(roots.map(span => span.attributes["lmnr.association.properties.session_id"]))
    .toEqual(["laminar-first", "laminar-first", "laminar-second"]);
  expect(roots.map(root => read(root, "lmnr.span.input")[0].content[0].text))
    .toEqual(["Prepared request 1", "Prepared request 3", "Prepared request 4"]);
  expect(read(roots[0]!, "lmnr.span.input")).toEqual([
    { role: "system", content: [{ type: "text", text: "Prepared request 1" }] },
    { role: "user", content: [{ type: "text", text: "Check weather." }] },
  ]);
  for (const root of roots) {
    expect(root.attributes["lmnr.association.properties.tags"]).toEqual(["laminar-test"]);
    expect(root.attributes["lmnr.association.properties.metadata.sessionId"]).toBe(session.id);
  }
  for (const span of spans.filter(span => span.attributes["lmnr.span.type"] !== "EXECUTOR")) {
    expect(Object.keys(span.attributes).some(key => key.startsWith("lmnr.association.properties.metadata."))).toBe(false);
  }
  expect(read(roots[1]!, "lmnr.span.output")).toEqual([
    { role: "assistant", content: [{ type: "text", text: "Bring water." }] },
  ]);
  const turn = spans.find(span => span.name === "turn 1")!;
  expect(turn.attributes["lmnr.span.type"]).toBe("DEFAULT");
  expect(read(turn, "lmnr.span.input")[0].role).toBe("system");
  const models = spans.filter(span => span.attributes["lmnr.span.type"] === "LLM");
  expect(read(models[0]!, "lmnr.span.output")[0].parts).toEqual([
    { type: "thinking", content: "Check first." },
    { type: "tool_call", id: "weather-1", name: "weather", arguments: {} },
    { type: "text", content: "Checking." },
  ]);
  expect(read(models[1]!, "lmnr.span.input").at(-1).parts[0]).toEqual({
    type: "tool_call_response", id: "weather-1", result: { temperature: 30 },
  });
  expect(read(models[2]!, "lmnr.span.input").map((message: { role: string }) => message.role))
    .toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
  expect(read(models[3]!, "lmnr.span.input").map((message: { role: string }) => message.role)).toEqual(["system", "user"]);
  const tool = spans.find(span => span.attributes["lmnr.span.type"] === "TOOL")!;
  expect(read(tool, "lmnr.span.input")).toEqual({});
  expect(read(tool, "lmnr.span.output")).toEqual({ temperature: 30 });
  expect(read(models[0]!, "tessar.output").content[0].type).toBe("reasoning");
});
