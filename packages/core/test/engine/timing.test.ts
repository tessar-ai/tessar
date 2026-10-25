import { z } from "zod";
import { expect, it, vi } from "vitest";
import { AgentHarness } from "../../src/testing/harness.js";
import {
  AssistantMessage,
  HumanMessage,
  MessageCodec,
  defineInterruption,
  ToolDecision,
  createTool,
  normalizeInstruction,
  stream as events,
} from "../../src/index.js";
const model = { providerId: "scripted", modelId: "test" };
it.each([false, true])("exposes record timestamps consistently on Stream, Turn, model and tool events; tool failure=%s", async (fails) => {
  const work = createTool({
    name: "work", description: "Timing", schema: z.object({}),
    execute: () => { if (fails) throw Error("Tool failed"); return "done"; },
  });
  const h = await AgentHarness.create({
    tools: { work }, modelScripts: [{ response: { message: MessageCodec.encode(new AssistantMessage([
      { type: "tool-call", name: "work", toolCallId: "work", arguments: {} },
    ])) } }, { text: "answer" }],
  });
  try {
    const stream = h.agent.stream("work");
    const events = await h.collect(stream), records = await h.records(stream.id!);
    const timing = (record: { startedAt: string | null; endedAt: string | null }) => ({
      startedAt: record.startedAt, endedAt: record.endedAt,
    });
    expect(events.find((event) => event.type === "stream.started")!.payload).toMatchObject({ startedAt: records.stream.startedAt });
    expect(events.find((event) => event.type === "stream.end")!.payload).toMatchObject(timing(records.stream));
    for (const record of records.turns) {
      expect(events.find((event) => event.type === "turn.start" && event.payload.turnId === record.id)!.payload).toMatchObject({ startedAt: record.startedAt });
      expect(events.find((event) => event.type === "turn.end" && event.payload.turnId === record.id)!.payload).toMatchObject(timing(record));
    }
    for (const record of records.attempts) {
      expect(events.find((event) => event.type === "model.start" && event.payload.attemptId === record.id)!.payload).toMatchObject({ startedAt: record.startedAt });
      expect(events.find((event) => event.type === "model.end" && event.payload.attemptId === record.id)!.payload).toMatchObject(timing(record));
    }
    for (const record of records.tools) {
      expect(events.find((event) => event.type === "tool.start" && event.payload.toolExecutionId === record.id)!.payload).toMatchObject({ startedAt: record.startedAt });
      expect(events.find((event) => event.type === "tool.end" && event.payload.toolExecutionId === record.id)!.payload).toMatchObject(timing(record));
      if (fails) expect(events.find((event) => event.type === "tool.error" && event.payload.toolExecutionId === record.id)!.payload).toMatchObject(timing(record));
    }
  } finally { await h.dispose(); }
});

it("exposes failed primary model timestamps and the final Stream/Turn record times", async () => {
  const h = await AgentHarness.create({ modelScripts: [{ error: Error("Provider unavailable") }] });
  try {
    const stream = h.agent.stream("hello"), events = await h.collect(stream);
    const records = await h.records(stream.id!);
    const attempt = records.attempts[0]!;
    expect(events.find((event) => event.type === "model.error")!.payload).toMatchObject({ startedAt: attempt.startedAt, endedAt: attempt.endedAt });
    expect(events.find((event) => event.type === "stream.end")!.payload).toMatchObject({ startedAt: records.stream.startedAt, endedAt: records.stream.endedAt });
    const turn = records.turns[0]!;
    expect(events.find((event) => event.type === "turn.end")!.payload).toMatchObject({ startedAt: turn.startedAt, endedAt: turn.endedAt });
  } finally { await h.dispose(); }
});

it("measures monotonic attempt duration and first output", async () => {
  let now = 0;
  const timer = vi.spyOn(performance, "now").mockImplementation(() => now);
  const h = await AgentHarness.create();
  h.provider.stream = async function* () {
    now += 10;
    yield {
      type: "message-delta",
      messageId: "answer",
      partId: "text",
      partKind: "text",
      delta: "ok",
    };
    now += 30;
    yield {
      type: "response",
      response: { message: MessageCodec.encode(new AssistantMessage("ok")) },
    };
  };
  try {
    const thread = await h.createThread(),
      stream = h.admit({
        kind: "input",
        threadId: thread.id,
        input: [MessageCodec.encode(new HumanMessage("hello"))],
        model,
      });
    await h.collect(stream);
    const records = await h.records(stream.id!);
    expect(records.attempts[0]).toMatchObject({
      durationMs: 40,
      timeToFirstOutputMs: 10,
    });
    expect(records.stream.durationMs).toBe(40);
  } finally {
    await h.dispose();
    timer.mockRestore();
  }
});
it.each(["closed", "legacy", "open"] as const)(
  "excludes suspension wait; incomplete legacy timing=%s stays unknown",
  async (mode) => {
    let now = 0;
    const timer = vi.spyOn(performance, "now").mockImplementation(() => now);
    const approval = defineInterruption({
      id: "pause",
      version: 1,
      response: { jsonSchema: {}, parse: () => ({}) },
      resolve: () => ToolDecision.allow(),
    });
    const h = await AgentHarness.create({
      modelScripts: [{ text: "ok" }],
      plugins: [
        {
          id: "approval",
          setup(tessar) {
            tessar.interruptions.register(approval);
            tessar.hook(events.before, (_event, ctx) => {
              now += 20;
              return ctx.suspend(approval, {});
            });
          },
        },
      ],
    });
    const original = h.provider.stream.bind(h.provider);
    h.provider.stream = async function* (request, context) {
      now += 30;
      yield* original(request, context);
    };
    try {
      const thread = await h.createThread(),
        stream = h.admit({
          kind: "input",
          threadId: thread.id,
          input: [MessageCodec.encode(new HumanMessage("hello"))],
          model,
        });
      const result = await h.collect(stream),
        pending = result.find((e) => e.type === events.suspended)!;
      if (mode !== "closed") {
        const get = h.backend.checkpoints.get;
        h.backend.checkpoints.get = async (id) => {
          const value = structuredClone(await get(id));
          if (value?.execution) {
            if (mode === "legacy") delete value.execution.timing;
            else value.execution.timing!.segmentOpen = true;
          }
          return value;
        };
      }
      now += 10000;
      await h.collect(
        h.admit({
          kind: "resume",
          threadId: thread.id,
          interruptId: pending.payload.interrupt.id,
          value: {},
        }),
      );
      expect((await h.records(stream.id!)).stream.durationMs).toBe(
        mode === "closed" ? 50 : null,
      );
    } finally {
      await h.dispose();
      timer.mockRestore();
    }
  },
);

it("measures auxiliary calls and leaves uncommitted responseMessageId null", async () => {
  let now = 0,
    call = 0;
  const timer = vi.spyOn(performance, "now").mockImplementation(() => now);
  const work = createTool({
    name: "work",
    description: "auxiliary",
    schema: z.object({}),
    execute: async (_input, context) => {
      for await (const _ of context.models.stream({
        model,
        purpose: "auxiliary",
        request: {
          model,
          instructions: normalizeInstruction(""),
          messages: [],
          tools: [],
        },
      })) {
      }
      return "done";
    },
  });
  const h = await AgentHarness.create({ tools: { work } });
  h.provider.stream = async function* () {
    call++;
    const message = MessageCodec.encode(
      new AssistantMessage(
        call === 1
          ? [
              {
                type: "tool-call",
                toolCallId: "work",
                name: "work",
                arguments: {},
              },
            ]
          : "answer",
      ),
    );
    if (call === 2) {
      now += 10;
      yield {
        type: "message-delta",
        messageId: message.id,
        partId: "text",
        partKind: "text",
        delta: "answer",
      };
      now += 30;
    }
    yield { type: "response", response: { message } };
  };
  try {
    const thread = await h.createThread(),
      stream = h.admit({
        kind: "input",
        threadId: thread.id,
        input: [MessageCodec.encode(new HumanMessage("ask"))],
        model,
      });
    await h.collect(stream);
    const records = await h.records(stream.id!);
    expect(
      records.attempts.find((a) => a.purpose === "auxiliary"),
    ).toMatchObject({
      durationMs: 40,
      timeToFirstOutputMs: 10,
      responseMessageId: null,
    });
    expect(
      records.attempts
        .filter((a) => a.purpose === "primary")
        .every((a) => a.timeToFirstOutputMs === null),
    ).toBe(true);
  } finally {
    await h.dispose();
    timer.mockRestore();
  }
});
