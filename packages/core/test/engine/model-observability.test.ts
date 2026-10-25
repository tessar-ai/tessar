import { expect, it } from "vitest";
import { z } from "zod";
import { AgentHarness } from "../../src/testing/harness.js";
import { AssistantMessage, HumanMessage } from "../../src/messages/message.js";
import { MessageCodec } from "../../src/messages/codec.js";
import { createTool } from "../../src/tools/tool.js";
import { buildInstruction } from "../../src/instructions/instruction.js";
import type { StreamEvent } from "../../src/events/definition.js";

it("correlates primary and concurrent auxiliary lifecycle events with their exact inputs and parent tools", async () => {
  const model = { providerId: "scripted", modelId: "test" };
  const helper = createTool({
    name: "helper", description: "Run an auxiliary model", schema: z.object({ task: z.string() }),
    execute: async ({ task }, context) => {
      for await (const _ of context.models.stream({
        model, purpose: "auxiliary",
        request: { model, instructions: buildInstruction([{ id: "task", content: task }]), messages: [], tools: [] },
      })) { /* Consume the complete auxiliary response. */ }
      return "done";
    },
  });
  const harness = await AgentHarness.create({
    tools: { helper },
    modelScripts: [
      { response: { message: MessageCodec.encode(new AssistantMessage([
        { type: "tool-call", toolCallId: "a", name: "helper", arguments: { task: "first" } },
        { type: "tool-call", toolCallId: "b", name: "helper", arguments: { task: "second" } },
      ])) } },
      { text: "private first", usage: { inputTokens: 3, outputTokens: 1 } },
      { text: "private second", usage: { inputTokens: 4, outputTokens: 2 } },
      { text: "public answer" },
    ],
  });
  try {
    const thread = await harness.createThread();
    const stream = harness.admit({ kind: "input", threadId: thread.id,
      input: [MessageCodec.encode(new HumanMessage("go"))], model });
    const events = await harness.collect(stream);
    const records = await harness.records(stream.id!);
    const starts = events.filter(event => event.type === "model.start");
    expect(starts).toHaveLength(4);
    expect(starts.map(event => event.payload.attemptId).sort()).toEqual(records.attempts.map(attempt => attempt.id).sort());
    for (const event of starts) {
      const record = records.attempts.find(attempt => attempt.id === event.payload.attemptId)!;
      expect(event.payload).toMatchObject({ purpose: record.purpose, parentToolExecutionId: record.parentToolExecutionId, startedAt: record.startedAt });
      expect(event.payload.request).toEqual(harness.provider.calls[records.attempts.indexOf(record)]);
      expect(events.some(end => end.type === "model.end" && end.payload.attemptId === record.id)).toBe(true);
      expect(events.find(end => end.type === "model.end" && end.payload.attemptId === record.id)!.payload).toMatchObject({ startedAt: record.startedAt, endedAt: record.endedAt });
    }
    const deltas = events.filter(event => event.type === "message.delta");
    expect(deltas.map(event => event.payload.delta)).not.toContain("private first");
    expect(events.filter(event => event.type === "model.usage")).toHaveLength(4);
    expect(events.filter(event => event.type === "state_changed").at(-1)?.payload.state.messages
      .flatMap(message => message.content).filter(part => part.type === "text").map(part => part.text)).toContain("public answer");
  } finally {
    await harness.dispose();
  }
});

it("reports auxiliary errors without turning a caught helper failure into a conversation error", async () => {
  const events: StreamEvent[] = [];
  const model = { providerId: "scripted", modelId: "test" };
  const harness = await AgentHarness.create({
    modelScripts: [{ text: "public answer" }, { error: Error("helper failed") }],
    plugins: [{ id: "helper", setup(tessar) {
      tessar.hook("turn.decision", async (_event, context) => {
        try {
          for await (const _ of context.models.stream({ model, purpose: "auxiliary",
            request: { model, instructions: buildInstruction([]), messages: [], tools: [] } })) {}
        } catch { /* The plugin deliberately handles its auxiliary failure. */ }
      });
    } }],
  });
  try {
    const thread = await harness.createThread();
    const stream = harness.admit({ kind: "input", threadId: thread.id, input: [MessageCodec.encode(new HumanMessage("go"))], model });
    events.push(...await harness.collect(stream));
    const failure = events.find(event => event.type === "model.error");
    expect(failure?.payload).toMatchObject({ purpose: "auxiliary", error: { message: "helper failed" } });
    const attempt = (await harness.records(stream.id!)).attempts.find((record) => record.purpose === "auxiliary")!;
    expect(failure!.payload).toMatchObject({ startedAt: attempt.startedAt, endedAt: attempt.endedAt });
    const states = events.filter(event => event.type === "state_changed").map(event => event.payload.state);
    expect(states.every(state => state.error === null)).toBe(true);
    expect(states.at(-1)?.status).toBe("completed");
  } finally {
    await harness.dispose();
  }
});
