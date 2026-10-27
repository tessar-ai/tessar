import {
  tool as toolHooks,
  stream as streamHooks,
  model as modelHooks,
  turn as turnHooks,
} from "../../src/events/type.js";
import { z } from "zod";
import { expect, it } from "vitest";
import { AgentHarness } from "../../src/testing/harness.js";
import { defineInterruption } from "../../src/engine/interrupt.js";
import { ToolDecision } from "../../src/events/type.js";
import { AssistantMessage, HumanMessage } from "../../src/messages/message.js";
import { MessageCodec } from "../../src/messages/codec.js";
import { createTool } from "../../src/tools/tool.js";
import { TessarError } from "../../src/errors.js";
const Approval = defineInterruption({
  id: "approval.request",
  version: 1,
  response: {
    jsonSchema: {
      type: "object",
      properties: { approved: { type: "boolean" } },
    },
    parse(value: unknown) {
      if (
        !value ||
        typeof (value as { approved?: unknown }).approved !== "boolean"
      )
        throw Error("Invalid approval");
      return value as { approved: boolean };
    },
  },
  resolve: (response) =>
    response.approved ? ToolDecision.allow() : ToolDecision.deny("declined"),
});
it("keeps an interrupt pending when a JavaScript resolver returns a decision for another boundary", async () => {
  const invalid = defineInterruption({ id: "invalid-decision", version: 1,
    response: { jsonSchema: {}, parse: (value: unknown) => value },
    resolve: () => ({ decision: "retry" as const }),
  });
  const h = await AgentHarness.create({ plugins: [{ id: "invalid", setup(tessar) {
    tessar.interruptions.register(invalid);
    tessar.hook("stream.before", (_event, context) => context.suspend(invalid as any, {}));
  } }] });
  try {
    const thread = await h.createThread();
    const first = h.admit({ kind: "input", threadId: thread.id, input: [MessageCodec.encode(new HumanMessage("hello"))], model: { providerId: "scripted", modelId: "test" } });
    const paused = (await h.collect(first)).find(event => event.type === "stream.suspended")!;
    await expect(h.collect(h.admit({ kind: "resume", threadId: thread.id, interruptId: paused.payload.interrupt.id, value: true }))).rejects.toMatchObject({ code: "InvalidResumeResponse" });
    expect((await h.queries.getRecord("interrupts", thread.id, paused.payload.interrupt.id))!.status).toBe("pending");
  } finally { await h.dispose(); }
});
it("suspends durably, validates before consume, and resumes past previous handlers", async () => {
  let executions = 0,
    before = 0,
    after = 0;
  const harness = await AgentHarness.create({
    modelScripts: [
      {
        response: {
          message: MessageCodec.encode(
            new AssistantMessage([
              {
                type: "tool-call",
                toolCallId: "c",
                name: "write",
                arguments: {},
              },
            ]),
          ),
        },
      },
      { text: "done" },
    ],
    plugins: [
      {
        id: "tools",
        setup(tessar) {
          tessar.tools.register(
            createTool({
              name: "write",
              description: "write",
              schema: z.object({}),
              execute: async () => {
                executions++;
                return "wrote";
              },
            }),
          );
        },
      },
      {
        id: "approval",
        setup(tessar) {
          tessar.interruptions.register(Approval);
          tessar.hook(toolHooks.before, () => {
            before++;
            return ToolDecision.allow();
          });
          tessar.hook(toolHooks.before, (_event, context) =>
            context.suspend(Approval, { question: "allow?" }),
          );
          tessar.hook(toolHooks.before, () => {
            after++;
            return ToolDecision.allow();
          });
        },
      },
    ],
  });
  try {
    const thread = await harness.createThread(),
      first = harness.admit({
        kind: "input",
        threadId: thread.id,
        input: [MessageCodec.encode(new HumanMessage("write"))],
        model: { providerId: "scripted", modelId: "test" },
      });
    const events = await harness.collect(first),
      pending = events.find((e) => e.type === streamHooks.suspended)!;
    expect(pending).toBeDefined();
    expect(executions).toBe(0);
    expect(before).toBe(1);
    const interruptId = pending.payload.interrupt.id;
    await expect(
      harness.collect(
        harness.admit({
          kind: "resume",
          threadId: thread.id,
          interruptId,
          value: { approved: "wrong" },
        }),
      ),
    ).rejects.toMatchObject({ code: "InvalidResumeResponse" });
    expect(
      (await harness.queries.getRecord("interrupts", thread.id, interruptId))!
        .status,
    ).toBe("pending");
    const resumed = harness.admit({
      kind: "resume",
      threadId: thread.id,
      interruptId,
      value: { approved: true },
      model: { providerId: "scripted", modelId: "alternate" },
    });
    const duplicate = harness.admit({
      kind: "resume",
      threadId: thread.id,
      interruptId,
      value: { approved: true },
    });
    const results = await Promise.allSettled([
      harness.collect(resumed),
      harness.collect(duplicate),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason.code,
    ).toBe("AlreadyResumed");
    expect(resumed.id).toBe(first.id);
    expect(resumed.handleId).not.toBe(first.handleId);
    expect(executions).toBe(1);
    expect(before).toBe(1);
    expect(after).toBe(1);
    expect(
      (await harness.records(first.id!)).attempts.map((a) => a.modelId),
    ).toEqual(["test", "alternate"]);
    await expect(
      harness.collect(
        harness.admit({
          kind: "resume",
          threadId: thread.id,
          interruptId,
          value: { approved: true },
        }),
      ),
    ).rejects.toMatchObject({ code: "AlreadyResumed" });
  } finally {
    await harness.dispose();
  }
});
it.each([
  streamHooks.before,
  modelHooks.select,
  turnHooks.decision,
  modelHooks.recover,
])("resumes supported decision boundary $id", async (boundary) => {
  const Resume = defineInterruption({
    id: "boundary.resume",
    version: 1,
    response: Approval.response,
    resolve: () => ({
      decision:
        boundary === modelHooks.recover
          ? ("retry" as const)
          : ("allow" as const),
    }),
  });
  let asks = 0;
  const harness = await AgentHarness.create({
    modelScripts:
      boundary === modelHooks.recover
        ? [
            { error: new TessarError("ProviderError", "fixture failure") },
            { text: "done" },
          ]
        : [{ text: "done" }],
    plugins: [
      {
        id: "boundary",
        setup(tessar) {
          tessar.interruptions.register(Resume);
          tessar.hook(boundary, (_event, context) => {
            asks++;
            return (context as import("../../src/engine/interrupt.js").DecisionHookContext).suspend(Resume, {});
          });
        },
      },
    ],
  });
  try {
    const thread = await harness.createThread(),
      stream = harness.admit({
        kind: "input",
        threadId: thread.id,
        input: [MessageCodec.encode(new HumanMessage("ask"))],
        model: { providerId: "scripted", modelId: "test" },
      });
    const events = await harness.collect(stream),
      request = events.find((e) => e.type === streamHooks.suspended)!.payload
        .interrupt;
    await harness.collect(
      harness.admit({
        kind: "resume",
        threadId: thread.id,
        interruptId: request.id,
        value: { approved: true },
      }),
    );
    expect(asks).toBe(1);
    expect((await harness.records(stream.id!)).stream.status).toBe("completed");
  } finally {
    await harness.dispose();
  }
});
