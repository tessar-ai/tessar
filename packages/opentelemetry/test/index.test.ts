import { expect, it, onTestFinished } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { AgentHarness } from "@tessar/core/testing";
import { AssistantMessage, MessageCodec, TessarError, ToolMessage, createTool } from "@tessar/core";
import { createSqliteBackend } from "@tessar/sqlite";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import {
  OpenTelemetryPlugin,
  LangfuseAdapter,
  type LangfuseOptions,
  type OpenTelemetryOptions,
} from "../src/index.js";

const captured = { spans: [] as ReadableSpan[][], closed: [] as boolean[] };
class CaptureAdapter extends LangfuseAdapter {
  override createExporter(): SpanExporter {
    const index = captured.spans.length;
    const spans: ReadableSpan[] = [];
    captured.spans.push(spans);
    captured.closed.push(false);
    return {
      export: (batch, done) => {
        spans.push(...batch.map((span) => this.mapSpan(span)));
        done({ code: 0 });
      },
      async shutdown() {
        captured.closed[index] = true;
      },
    };
  }
}
function createTracing(
  options: LangfuseOptions &
    Pick<OpenTelemetryOptions, "traceName" | "tags"> = {},
) {
  const { traceName, tags, ...adapter } = options;
  return new OpenTelemetryPlugin({
    traceName,
    tags,
    adapters: [
      new CaptureAdapter({
        publicKey: "pk-test",
        secretKey: "sk-test",
        ...adapter,
      }),
    ],
  });
}

const decode = (span: ReadableSpan, key: string) => {
  const value = span.attributes[key];
  return typeof value === "string" ? JSON.parse(value) : value;
};
const type = (span: ReadableSpan) =>
  span.attributes["langfuse.observation.type"];
const metadata = (span: ReadableSpan, key: string) =>
  decode(span, "langfuse.observation.metadata." + key);
const response = (name: string) => ({
  response: {
    message: MessageCodec.encode(
      new AssistantMessage([
        { type: "tool-call" as const, toolCallId: "call", name, arguments: {} },
      ]),
    ),
  },
});

const spanTime = (time: readonly [number, number]) =>
  new Date(time[0] * 1000 + time[1] / 1e6).toISOString();

it("starts Session Turns at their recorded start before commit and context preparation across follow-ups", async () => {
  const start = captured.spans.length;
  const starts = new Map<string, string>();
  const harness = await AgentHarness.create({
    modelScripts: [{ text: "first answer" }, { text: "second answer" }],
    plugins: [createTracing(), {
      id: "slow-context",
      setup(tessar) {
        tessar.hook("turn.start", (event) => {
          starts.set(event.payload.turnId, event.payload.startedAt!);
        });
        tessar.hook("context.prepare", async () => { await delay(30); });
      },
    }],
  });
  const stage = harness.backend.commits.stage;
  harness.backend.commits.stage = async (batch) => { await delay(5); await stage(batch); };
  try {
    const session = await harness.controller.createSession({ threadId: "turn-timing" });
    for (const input of ["first", "second"]) {
      const done = new Promise<void>((resolve, reject) => {
        const stop = session.subscribe((event) => {
          if (event.type === "stream.end") { stop(); resolve(); }
          if (event.type === "stream.error") { stop(); reject(Error(event.payload.error.message)); }
        });
      });
      await session.followUp(input);
      await done;
    }
  } finally { await harness.dispose(); }
  const turns = captured.spans[start]!.filter((span) => span.name.startsWith("turn "));
  expect(turns.map((span) => span.name)).toEqual(["turn 1", "turn 2"]);
  for (const turn of turns)
    expect(spanTime(turn.startTime)).toBe(starts.get(metadata(turn, "turnId")));
});

it("uses record lifetimes for Agent, model and tool spans despite delayed publication", async () => {
  const start = captured.spans.length;
  const work = createTool({ name: "work", description: "Work", schema: z.object({}), execute: () => "ok" });
  const h = await AgentHarness.create({ tools: { work }, modelScripts: [response("work"), { text: "done" }], plugins: [createTracing()] });
  const stage = h.backend.commits.stage;
  h.backend.commits.stage = async (batch) => { await delay(5); await stage(batch); };
  let records: Awaited<ReturnType<typeof h.records>>;
  try {
    const result = await h.agent.generate("work");
    records = await h.records(result.streamId);
  } finally { await h.dispose(); }
  const spans = captured.spans[start]!;
  for (const [kind, rows, key] of [
    ["agent", [records!.stream], "streamId"],
    ["generation", records!.attempts, "attemptId"],
    ["tool", records!.tools, "toolExecutionId"],
  ] as const) for (const record of rows) {
    const span = spans.find((span) => type(span) === kind && metadata(span, key) === record.id)!;
    expect(spanTime(span.startTime)).toBe(record.startedAt);
    expect(spanTime(span.endTime)).toBe(record.endedAt);
  }
});

it("parents post-Turn auxiliary work to the Agent without reopening an ended Turn", async () => {
  const start = captured.spans.length;
  const model = { providerId: "scripted", modelId: "test" };
  const h = await AgentHarness.create({ modelScripts: [{ text: "answer" }, { text: "auxiliary" }], plugins: [createTracing(), {
    id: "after-turn", setup(tessar) {
      tessar.hook("turn.decision", async (_event, context) => {
        for await (const _ of context.models.stream({ model, instructions: { sections: [] }, messages: [], tools: [] })) {}
      });
    },
  }] });
  try { await h.agent.generate("hello"); }
  finally { await h.dispose(); }
  const spans = captured.spans[start]!;
  expect(spans.filter((span) => type(span) === "span")).toHaveLength(1);
  const root = spans.find((span) => type(span) === "agent")!;
  const auxiliary = spans.find((span) => metadata(span, "purpose") === "auxiliary")!;
  expect(auxiliary.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  expect(metadata(root, "status")).toBe("completed");
});

it.each([false, true])("ends a parallel tool span at execution completion, including failures=%s", async (fails) => {
  const start = captured.spans.length;
  const fast = createTool({
    name: "fast", description: "Fast tool", schema: z.object({}),
    execute: () => {
      if (fails) throw Error("Fast tool failed");
      return "fast result";
    },
  });
  const slow = createTool({
    name: "slow", description: "Slow tool", schema: z.object({}),
    execute: async () => { await delay(80); return "slow result"; },
  });
  const harness = await AgentHarness.create({
    tools: { fast, slow },
    modelScripts: [{ response: { message: MessageCodec.encode(new AssistantMessage(
      ["fast", "slow"].map((name) => ({ type: "tool-call" as const, name, toolCallId: name, arguments: {} })),
    )) } }, { text: "done" }],
    plugins: [createTracing()],
  });
  let records: Awaited<ReturnType<typeof harness.records>>;
  try {
    const stream = harness.agent.stream("Run both tools");
    await harness.collect(stream);
    records = await harness.records(stream.id!);
  } finally { await harness.dispose(); }
  const spans = captured.spans[start]!;
  for (const record of records!.tools) {
    const span = spans.find((span) => metadata(span, "toolExecutionId") === record.id)!;
    expect(spanTime(span.endTime)).toBe(record.endedAt);
  }
  expect(records!.tools.find((record) => record.toolName === "fast")!.status).toBe(fails ? "failed" : "succeeded");
});

it("uses publication time for a cached tool notification without a fresh start", async () => {
  const start = captured.spans.length;
  const harness = await AgentHarness.create({
    modelScripts: [{ text: "done" }],
    plugins: [createTracing(), {
      id: "cached-tool-notification",
      setup(tessar) {
        tessar.hook("context.prepare", async (_event, context) => {
          await context.events.emit("tool.end", {
            toolExecutionId: "cached-execution", toolCallId: "cached-call",
            result: MessageCodec.encode(new ToolMessage("saved result", { toolCallId: "cached-call" })),
            status: "succeeded", endedAt: "2000-01-01T00:00:00.000Z",
          });
        });
      },
    }],
  });
  try {
    await harness.agent.generate("Cached result");
  } finally { await harness.dispose(); }
  const recovered = captured.spans[start]!.find((span) => metadata(span, "toolExecutionId") === "cached-execution")!;
  expect(recovered.endTime).toEqual(recovered.startTime);
  expect(decode(recovered, "tessar.output").content[0].text).toBe("saved result");
});

it("exports stream/turn/model/tool hierarchy including auxiliary calls and exclusive token buckets", async () => {
  const start = captured.spans.length;
  const model = { providerId: "scripted", modelId: "test" };
  const helper = createTool({
    name: "helper",
    description: "Helper",
    schema: z.object({}),
    execute: async (_input, context) => {
      for await (const _ of context.models.stream({
          model,
          instructions: { sections: [] },
          messages: [],
          tools: [],
        })) {
      }
      return "tool result";
    },
  });
  const harness = await AgentHarness.create({
    tools: { helper },
    plugins: [
      createTracing({
        publicKey: "pk-test",
        secretKey: "sk-test",
        baseUrl: "http://localhost:3000",
        traceName: "tool conversation",
        tags: ["demo", "tools"],
        prompt: { name: "agent-system", version: 2 },
      }),
    ],
    modelScripts: [
      response("helper"),
      { text: "auxiliary" },
      {
        text: "answer",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 40,
          cacheWriteInputTokens: 10,
          reasoningOutputTokens: 5,
        },
      },
    ],
  });
  try {
    expect((await harness.agent.generate("hello", { model })).status).toBe(
      "completed",
    );
  } finally {
    await harness.dispose();
  }
  const spans = captured.spans[start]!;
  const agent = spans.find((span) => type(span) === "agent")!;
  const turns = spans.filter((span) => type(span) === "span");
  const generations = spans.filter((span) => type(span) === "generation");
  const tool = spans.find((span) => type(span) === "tool")!;
  expect(turns).toHaveLength(2);
  expect(generations).toHaveLength(3);
  const firstTurn = turns.find((span) => span.name === "turn 1")!;
  const secondTurn = turns.find((span) => span.name === "turn 2")!;
  expect(firstTurn).toBeDefined();
  expect(secondTurn).toBeDefined();
  const firstGeneration = generations.find(
    (span) => span.parentSpanContext?.spanId === firstTurn.spanContext().spanId,
  )!;
  expect(decode(firstTurn, "langfuse.observation.input")).toEqual(
    decode(firstGeneration, "langfuse.observation.input"),
  );
  const firstOutput = decode(firstTurn, "langfuse.observation.output");
  expect(firstOutput.map((message: { role: string }) => message.role)).toEqual([
    "assistant",
    "tool",
  ]);
  expect(firstOutput[0].content[0].type).toBe("tool-call");
  expect(firstOutput[1]).toEqual(decode(tool, "langfuse.observation.output"));
  expect(JSON.stringify(firstOutput)).not.toContain("auxiliary");
  expect(decode(secondTurn, "langfuse.observation.input").messages).toEqual(
    harness.provider.calls.at(-1)!.messages,
  );
  expect(
    decode(secondTurn, "langfuse.observation.output")[0].content[0].text,
  ).toBe("answer");
  expect(
    turns.every(
      (span) => span.parentSpanContext?.spanId === agent.spanContext().spanId,
    ),
  ).toBe(true);
  expect(
    generations.find((span) => metadata(span, "purpose") === "auxiliary")
      ?.parentSpanContext?.spanId,
  ).toBe(tool.spanContext().spanId);
  expect(decode(agent, "langfuse.observation.input")[0].role).toBe("user");
  expect(decode(agent, "langfuse.observation.output")).toEqual([
    ...firstOutput,
    ...decode(secondTurn, "langfuse.observation.output"),
  ]);
  const last = generations.find(
    (span) =>
      decode(span, "langfuse.observation.output")?.content?.[0]?.text ===
      "answer",
  )!;
  expect(decode(last, "langfuse.observation.usage_details")).toEqual({
    input: 50,
    input_cached_tokens: 40,
    input_cache_write: 10,
    output: 15,
    output_reasoning_tokens: 5,
    total: 120,
  });
  expect(decode(last, "langfuse.observation.input").messages).toBeDefined();
  expect(metadata(agent, "streamId")).toBeTruthy();
  expect(
    spans.every(
      (span) => span.attributes["langfuse.trace.name"] === "tool conversation",
    ),
  ).toBe(true);
  expect(
    spans.every(
      (span) =>
        JSON.stringify(span.attributes["langfuse.trace.tags"]) ===
        JSON.stringify(["demo", "tools"]),
    ),
  ).toBe(true);
  expect(last.attributes["langfuse.observation.model.name"]).toBe("test");
  expect(
    last.attributes["langfuse.observation.completion_start_time"],
  ).toBeDefined();
  expect(last.attributes["langfuse.observation.prompt.name"]).toBe(
    "agent-system",
  );
  expect(last.attributes["langfuse.observation.prompt.version"]).toBe(2);
  expect(
    generations.find((span) => metadata(span, "purpose") === "auxiliary")!
      .attributes["langfuse.observation.prompt.name"],
  ).toBeUndefined();
  expect(captured.closed[start]).toBe(true);
});

it("isolates concurrent streams without registering or replacing the application's global tracer provider", async () => {
  const { trace } = await import("@opentelemetry/api");
  const global = trace.getTracerProvider();
  const start = captured.spans.length;
  const harness = await AgentHarness.create({
    modelScripts: [{ text: "first" }, { text: "second" }],
    plugins: [createTracing()],
  });
  try {
    const streams = [
      harness.agent.stream("one", { model: harness.provider.ref }),
      harness.agent.stream("two", { model: harness.provider.ref }),
    ];
    await Promise.all(streams.map((stream) => harness.collect(stream)));
  } finally {
    await harness.dispose();
  }
  const spans = captured.spans[start]!;
  const roots = spans.filter((span) => type(span) === "agent");
  expect(roots).toHaveLength(2);
  expect(new Set(roots.map((span) => span.spanContext().traceId)).size).toBe(2);
  for (const root of roots) {
    const children = spans.filter(
      (span) => span.spanContext().traceId === root.spanContext().traceId,
    );
    expect(children).toHaveLength(3);
    expect(
      children.every(
        (span) => metadata(span, "streamId") === metadata(root, "streamId"),
      ),
    ).toBe(true);
  }
  expect(trace.getTracerProvider()).toBe(global);
});

it("records each retry as a separate generation and omits unknown token counts", async () => {
  const start = captured.spans.length;
  const harness = await AgentHarness.create({
    modelScripts: [{ error: Error("busy") }, { text: "recovered" }],
    plugins: [
      createTracing(),
      {
        id: "retry",
        setup(tessar) {
          tessar.hook("model.recover", () => ({ decision: "retry" }));
        },
      },
    ],
  });
  try {
    expect(
      (await harness.agent.generate("hello", { model: harness.provider.ref }))
        .status,
    ).toBe("completed");
  } finally {
    await harness.dispose();
  }
  const generations = captured.spans[start]!.filter(
    (span) => type(span) === "generation",
  );
  expect(generations).toHaveLength(2);
  expect(
    new Set(generations.map((span) => metadata(span, "attemptId"))).size,
  ).toBe(2);
  expect(
    generations.find((span) => span.status.code === 2)?.attributes[
      "langfuse.observation.status_message"
    ],
  ).toBe("busy");
  const success = generations.find((span) => span.status.code !== 2)!;
  expect(decode(success, "langfuse.observation.usage_details")).toBeUndefined();
  const turn = captured.spans[start]!.find((span) => span.name === "turn 1")!;
  expect(turn).toBeDefined();
  expect(decode(turn, "langfuse.observation.input")).toEqual(
    decode(success, "langfuse.observation.input"),
  );
  expect(decode(turn, "langfuse.observation.output")).toEqual([
    decode(success, "langfuse.observation.output"),
  ]);
});

it("gives restart/resume a fresh Agent trace grouped with the suspended segment", async () => {
  const start = captured.spans.length;
  const directory = await mkdtemp(join(tmpdir(), "tessar-langfuse-"));
  onTestFinished(() =>
    rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  const filename = join(directory, "state.db");
  const ask = createTool({
    name: "ask",
    description: "Wait",
    schema: z.object({}),
    execute: (_input, context) => context.suspend({ question: "Continue?" }),
  });
  const first = await AgentHarness.create({
    backend: await createSqliteBackend({ filename }),
    tools: { ask },
    modelScripts: [response("ask")],
    plugins: [createTracing()],
  });
  let sessionId: string, interruptId: string, streamId: string;
  try {
    const session = await first.controller.createSession({
      threadId: "conversation",
      scope: { userId: "user-one" },
      model: first.provider.ref,
    });
    sessionId = session.id;
    const pending = new Promise<void>((resolve) =>
      session.subscribe("stream.suspended", (event) => {
        interruptId = event.payload.interrupt.id;
        streamId = event.streamId!;
        resolve();
      }),
    );
    await session.followUp("ask");
    await pending;
  } finally {
    await first.dispose();
  }
  const second = await AgentHarness.create({
    backend: await createSqliteBackend({ filename }),
    tools: { ask },
    modelScripts: [{ text: "resumed" }],
    plugins: [createTracing()],
  });
  try {
    const session = (await second.controller.getSession(sessionId!))!;
    const done = new Promise<void>((resolve) =>
      session.subscribe("stream.end", () => resolve()),
    );
    await session.resume({ interruptId: interruptId!, value: "yes" });
    await done;
  } finally {
    await second.dispose();
  }
  const roots = captured.spans
    .slice(start)
    .flat()
    .filter((span) => type(span) === "agent");
  expect(roots).toHaveLength(2);
  expect(new Set(roots.map((span) => span.spanContext().traceId)).size).toBe(2);
  const turns = captured.spans
    .slice(start)
    .flat()
    .filter((span) => type(span) === "span");
  expect(
    turns.every(
      (span) =>
        metadata(span, "streamId") === streamId! &&
        metadata(span, "threadId") === "conversation",
    ),
  ).toBe(true);
  expect(metadata(roots[0]!, "status")).toBe("suspended");
  expect(
    roots.every((span) => span.attributes["session.id"] === "conversation" && metadata(span, "sessionId") === sessionId!),
  ).toBe(true);
  expect(
    decode(roots[0]!, "langfuse.observation.output")[0].content[0].type,
  ).toBe("tool-call");
  const resumedTurns = captured.spans
    .slice(start + 1)
    .flat()
    .filter((span) => type(span) === "span");
  expect(resumedTurns.some((span) => span.name === "turn 1")).toBe(true);
  const originalTurn = turns.find((span) => span.name === "turn 1")!;
  const resumedTurn = resumedTurns.find((span) => span.name === "turn 1")!;
  expect(metadata(resumedTurn, "turnId")).toBe(metadata(originalTurn, "turnId"));
  expect(resumedTurn.spanContext().spanId).not.toBe(originalTurn.spanContext().spanId);
  expect(metadata(roots[1]!, "status")).toBe("completed");
  expect(metadata(roots[1]!, "inputSource")).toBe("resume");
  expect(decode(roots[1]!, "langfuse.observation.output").map((message: { role: string }) => message.role)).toEqual(["tool", "assistant"]);
  expect(resumedTurn.parentSpanContext?.spanId).toBe(roots[1]!.spanContext().spanId);
  const resumedTool = captured.spans
    .slice(start + 1)
    .flat()
    .find((span) => type(span) === "tool")!;
  expect(resumedTool.parentSpanContext?.spanId).toBe(
    resumedTurn.spanContext().spanId,
  );
  expect(resumedTool.duration[0] * 1e9 + resumedTool.duration[1]).toBeGreaterThanOrEqual(0);
  expect(resumedTurns.some((span) => span.name === "turn 2")).toBe(true);
});

it("gives a direct Agent resume a separate trace without requiring a Session", async () => {
  const start = captured.spans.length;
  const ask = createTool({
    name: "ask", description: "Ask", schema: z.object({}),
    execute: (_input, context) => context.suspend({ question: "Continue?" }),
  });
  const harness = await AgentHarness.create({
    tools: { ask }, modelScripts: [response("ask"), { text: "done" }],
    plugins: [createTracing()],
  });
  try {
    const pending = await harness.agent.generate("ask");
    expect(pending.status).toBe("suspended");
    await harness.collect(harness.agent.resume({
      threadId: pending.threadId, interruptId: pending.interrupt!.id, value: "yes",
    }));
  } finally { await harness.dispose(); }
  const roots = captured.spans[start]!.filter((span) => type(span) === "agent");
  expect(roots).toHaveLength(2);
  expect(new Set(roots.map((span) => span.spanContext().traceId)).size).toBe(2);
  expect(roots.every((span) => span.attributes["session.id"] === undefined)).toBe(true);
  expect(metadata(roots[0]!, "streamId")).toBe(metadata(roots[1]!, "streamId"));
});

it("captures saved tool publication before stream.resumed after SQLite recovery without repeating the tool", async () => {
  const start = captured.spans.length;
  const directory = await mkdtemp(join(tmpdir(), "tessar-trace-recovery-"));
  onTestFinished(() => rm(directory, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 100,
  }));
  const filename = join(directory, "state.db");
  const backend = await createSqliteBackend({ filename });
  const originalStage = backend.commits.stage;
  let failed = false, executed = 0;
  backend.commits.stage = async (batch) => {
    if (!failed && batch.checkpoint.cause === "MessageCommitted" && batch.checkpoint.state.messages.at(-1)?.role === "tool") {
      failed = true;
      throw new TessarError("StorageUnavailable", "Tool publication failed");
    }
    await originalStage(batch);
  };
  const work = createTool({
    name: "work", description: "Recover saved work", schema: z.object({}),
    execute: () => { executed++; return "saved work"; },
  });
  let sessionId: string, streamId: string;
  const first = await AgentHarness.create({
    backend, tools: { work }, modelScripts: [response("work")],
    plugins: [createTracing()],
  });
  try {
    const session = await first.controller.createSession({ threadId: "recovery-thread" });
    sessionId = session.id;
    const failure = new Promise<void>((resolve) => {
      const stop = session.subscribe("stream.error", (event) => {
        streamId = event.streamId!;
        stop(); resolve();
      });
    });
    await session.followUp("work");
    await failure;
    expect(executed).toBe(1);
    const saved = await first.records(streamId!);
    expect(saved.tools[0]!.result).not.toBeNull();
    expect(saved.messages.some((message) => message.role === "tool")).toBe(false);
  } finally { await first.dispose(); }
  const second = await AgentHarness.create({
    backend: await createSqliteBackend({ filename }), tools: { work },
    modelScripts: [{ text: "recovered" }], plugins: [createTracing()],
  });
  try {
    const session = (await second.controller.getSession(sessionId!))!;
    const done = new Promise<void>((resolve, reject) => {
      const stop = session.subscribe((event) => {
        if (event.type === "stream.end") { stop(); resolve(); }
        if (event.type === "stream.error") { stop(); reject(Error(event.payload.error.message)); }
      });
    });
    await session.recover({ streamId: streamId! });
    await done;
  } finally { await second.dispose(); }
  expect(executed).toBe(1);
  const spans = captured.spans.slice(start).flat();
  const roots = spans.filter((span) => type(span) === "agent");
  expect(roots).toHaveLength(2);
  expect(new Set(roots.map((span) => span.spanContext().traceId)).size).toBe(2);
  expect(roots.every((span) => span.attributes["session.id"] === "recovery-thread" && metadata(span, "streamId") === streamId!)).toBe(true);
  const recovered = captured.spans[start + 1]!;
  const tool = recovered.find((span) => type(span) === "tool")!;
  expect(tool).toBeDefined();
  expect(tool.name).toBe("work");
  expect(decode(tool, "tessar.input")).toEqual({});
  expect(decode(tool, "tessar.output").content[0].text).toBe("saved work");
  expect(tool.endTime).toEqual(tool.startTime);
  const turn = recovered.find((span) => span.name === "turn 1")!;
  expect(tool.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
  expect(turn.parentSpanContext?.spanId).toBe(roots[1]!.spanContext().spanId);
  expect(decode(turn, "tessar.output").map((message: { role: string }) => message.role)).toEqual(["tool"]);
  expect(decode(roots[1]!, "tessar.output").map((message: { role: string }) => message.role)).toEqual(["tool", "assistant"]);
  expect(recovered.some((span) => span.name === "turn 2")).toBe(true);
  expect(new Set(spans.map((span) => span.spanContext().spanId)).size).toBe(spans.length);
});

it("retains the actual Turn input and an empty output when its model fails", async () => {
  const start = captured.spans.length;
  const harness = await AgentHarness.create({
    modelScripts: [{ error: Error("provider unavailable") }],
    plugins: [createTracing()],
  });
  try {
    await expect(
      harness.agent.generate("hello", { model: harness.provider.ref }),
    ).rejects.toThrow("provider unavailable");
  } finally {
    await harness.dispose();
  }
  const spans = captured.spans[start]!;
  const turn = spans.find((span) => span.name === "turn 1")!;
  expect(turn).toBeDefined();
  expect(decode(turn, "tessar.input")).toEqual(harness.provider.calls[0]);
  expect(decode(turn, "langfuse.observation.output")).toEqual([]);
  expect(
    decode(
      spans.find((span) => type(span) === "agent")!,
      "langfuse.observation.output",
    ),
  ).toEqual([]);
  expect(
    decode(
      spans.find((span) => type(span) === "generation")!,
      "langfuse.observation.output",
    ),
  ).toBeUndefined();
});

it("uses the effective request and committed messages after application transforms", async () => {
  const start = captured.spans.length;
  const harness = await AgentHarness.create({
    modelScripts: [{ text: "raw answer" }],
    plugins: [
      createTracing(),
      {
        id: "transforms",
        setup(tessar) {
          tessar.hook("context.prepare", (event) => ({
            ...event.payload,
            options: { temperature: 0.25 },
          }));
          tessar.hook("message.prepare", (event) =>
            event.payload.role === "assistant"
              ? {
                  ...event.payload,
                  content: [{ type: "text", text: "committed answer" }],
                }
              : event.payload,
          );
        },
      },
    ],
  });
  try {
    await harness.agent.generate("hello", { model: harness.provider.ref });
  } finally {
    await harness.dispose();
  }
  const spans = captured.spans[start]!;
  const turn = spans.find((span) => span.name === "turn 1")!;
  const generation = spans.find((span) => type(span) === "generation")!;
  expect(decode(turn, "tessar.input")).toEqual(harness.provider.calls[0]);
  expect(decode(turn, "langfuse.observation.input").options).toEqual({
    temperature: 0.25,
  });
  expect(decode(turn, "langfuse.observation.output")[0].content[0].text).toBe(
    "committed answer",
  );
  expect(
    decode(generation, "langfuse.observation.output").content[0].text,
  ).toBe("raw answer");
});

it("gives each Session follow-up an Agent trace with shared grouping, continuous Turns and complete history", async () => {
  const start = captured.spans.length;
  const harness = await AgentHarness.create({
    instructions: "Remember the conversation.",
    modelScripts: [{ text: "first answer" }, { text: "second answer" }],
    plugins: [createTracing()],
  });
  let sessionId: string;
  try {
    const session = await harness.controller.createSession({
      threadId: "session-history",
      model: harness.provider.ref,
    });
    sessionId = session.id;
    for (const input of ["first question", "second question"]) {
      let stop = () => {};
      const completed = new Promise<void>((resolve, reject) => {
        stop = session.subscribe((event) => {
          if (event.type === "stream.end") resolve();
          if (event.type === "stream.error")
            reject(Error(event.payload.error.message));
        });
      });
      try {
        await session.followUp(input);
        await completed;
      } finally {
        stop();
      }
    }
  } finally {
    await harness.dispose();
  }
  const spans = captured.spans[start]!;
  const roots = spans.filter((span) => type(span) === "agent");
  const turns = spans.filter((span) => type(span) === "span");
  expect(roots).toHaveLength(2);
  expect(roots.every((span) => span.attributes["session.id"] === "session-history" && metadata(span, "sessionId") === sessionId!)).toBe(true);
  expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(2);
  expect(
    turns.every(
      (span) =>
        roots.some((root) => span.parentSpanContext?.spanId === root.spanContext().spanId && span.spanContext().traceId === root.spanContext().traceId),
    ),
  ).toBe(true);
  expect(turns.map((span) => span.name).sort()).toEqual(["turn 1", "turn 2"]);
  expect(
    turns.every((span) => metadata(span, "threadId") === "session-history"),
  ).toBe(true);
  expect(new Set(turns.map((span) => metadata(span, "streamId"))).size).toBe(2);
  for (const [index, root] of roots.entries()) {
    expect(decode(root, "langfuse.observation.input")).toHaveLength(1);
    expect(decode(root, "langfuse.observation.output")).toHaveLength(1);
    expect(decode(root, "langfuse.observation.input")[0].content[0].text).toBe(index === 0 ? "first question" : "second question");
    expect(decode(root, "langfuse.observation.output")[0].content[0].text).toBe(index === 0 ? "first answer" : "second answer");
    expect(metadata(root, "status")).toBe("completed");
  }
  expect(
    turns
      .map((span) => decode(span, "langfuse.observation.input").messages.length)
      .sort(),
  ).toEqual([2, 4]);
  for (const turn of turns) {
    const input = decode(turn, "langfuse.observation.input");
    expect(input.messages[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: "Remember the conversation." }],
    });
    expect(input).not.toHaveProperty("instructions");
    expect(input.messages.slice(1)).toEqual(
      decode(turn, "tessar.input").messages,
    );
  }
  expect(
    turns
      .map(
        (span) =>
          decode(span, "langfuse.observation.output")[0].content[0].text,
      )
      .sort(),
  ).toEqual(["first answer", "second answer"]);
});

it("keeps Thread traces isolated and continues their numbers after switching back", async () => {
  const start = captured.spans.length;
  const harness = await AgentHarness.create({
    modelScripts: [
      { text: "one" },
      { text: "two" },
      { text: "three" },
      { text: "four" },
    ],
    plugins: [createTracing()],
  });
  let firstId: string, secondId: string;
  try {
    const first = await harness.controller.createSession({
      threadId: "thread-a",
      model: harness.provider.ref,
    });
    const second = await harness.controller.createSession({
      threadId: "thread-c",
      model: harness.provider.ref,
    });
    firstId = first.id;
    secondId = second.id;
    for (const [index, session] of [first, first, second, first].entries()) {
      if (index === 1) await session.thread.create({ id: "thread-b" });
      if (index === 3) await session.thread.switch("thread-a");
      let stop = () => {};
      const completed = new Promise<void>((resolve, reject) => {
        stop = session.subscribe((event) => {
          if (event.type === "stream.end") resolve();
          if (event.type === "stream.error")
            reject(Error(event.payload.error.message));
        });
      });
      try {
        await session.followUp("hello");
        await completed;
      } finally {
        stop();
      }
    }
    await first.dispose();
    // The SDK's batch exporter drains when the Controller disposes its plugin.
  } finally {
    await harness.dispose();
  }
  const spans = captured.spans[start]!;
  const roots = spans.filter((span) => type(span) === "agent");
  expect(roots).toHaveLength(4);
  expect(new Set(roots.map((span) => span.spanContext().traceId)).size).toBe(4);
  const firstTurns = spans.filter(
    (span) =>
      type(span) === "span" && metadata(span, "sessionId") === firstId!,
  );
  expect(
    firstTurns
      .filter((span) => metadata(span, "threadId") === "thread-a")
      .map((span) => span.name)
      .sort(),
  ).toEqual(["turn 1", "turn 2"]);
  expect(
    firstTurns
      .filter((span) => metadata(span, "threadId") === "thread-b")
      .map((span) => span.name),
  ).toEqual(["turn 1"]);
  const secondTurns = spans.filter(
    (span) =>
      type(span) === "span" && metadata(span, "sessionId") === secondId!,
  );
  expect(secondTurns.map((span) => span.name)).toEqual(["turn 1"]);
  for (const root of roots) {
    const children = spans.filter(
      (span) =>
        span.spanContext().traceId === root.spanContext().traceId &&
        span !== root,
    );
    expect(
      children.every(
        (span) =>
          span.attributes["session.id"] === root.attributes["session.id"],
      ),
    ).toBe(true);
    expect(root.attributes["langfuse.trace.name"]).toContain(
      metadata(root, "threadId"),
    );
    expect(root.attributes["session.id"]).toBe(metadata(root, "threadId"));
  }
});

it("restores Thread grouping and Turn counters with a fresh Agent trace after restart", async () => {
  const start = captured.spans.length;
  const directory = await mkdtemp(join(tmpdir(), "tessar-langfuse-counter-"));
  onTestFinished(() =>
    rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  const filename = join(directory, "state.db");
  let sessionId: string;
  for (const index of [0, 1]) {
    const harness = await AgentHarness.create({
      backend: await createSqliteBackend({ filename }),
      modelScripts: [{ text: `answer ${index}` }],
      plugins: [createTracing()],
    });
    try {
      const session =
        index === 0
          ? await harness.controller.createSession({
              threadId: "persisted-conversation",
              model: harness.provider.ref,
            })
          : (await harness.controller.getSession(sessionId!))!;
      sessionId = session.id;
      const completed = new Promise<void>((resolve, reject) =>
        session.subscribe((event) => {
          if (event.type === "stream.end") resolve();
          if (event.type === "stream.error")
            reject(Error(event.payload.error.message));
        }),
      );
      await session.followUp("hello");
      await completed;
    } finally {
      await harness.dispose();
    }
  }
  const spans = captured.spans.slice(start).flat();
  const roots = spans.filter((span) => type(span) === "agent");
  const turns = spans.filter((span) => type(span) === "span");
  expect(roots).toHaveLength(2);
  expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(2);
  expect(roots.every((span) => span.attributes["session.id"] === "persisted-conversation")).toBe(true);
  expect(turns.map((span) => span.name)).toEqual(["turn 1", "turn 2"]);
  expect(
    turns.every(
      (span) =>
        roots.some((root) => span.parentSpanContext?.spanId === root.spanContext().spanId && span.spanContext().traceId === root.spanContext().traceId),
    ),
  ).toBe(true);
});
