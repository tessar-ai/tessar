import {
  tool as toolHooks,
  stream as streamHooks,
} from "../../src/events/type.js";
import { expect, it } from "vitest";
import { z } from "zod";
import { Agent, Controller } from "../../src/index.js";
import { AgentHarness } from "../../src/testing/harness.js";
import {
  AssistantMessage,
  HumanMessage,
  ToolMessage,
} from "../../src/messages/message.js";
import { MessageCodec } from "../../src/messages/codec.js";
import { createTool } from "../../src/tools/tool.js";
import { ToolDecision } from "../../src/events/type.js";
import { defineInterruption } from "../../src/engine/interrupt.js";
import { TessarError } from "../../src/errors.js";
import { normalizeInstruction } from "../../src/instructions/instruction.js";

const response = (count: number) => ({
  response: {
    message: MessageCodec.encode(
      new AssistantMessage(
        Array.from({ length: count }, (_, index) => ({
          type: "tool-call" as const,
          toolCallId: "call-" + index,
          name: "work",
          arguments: { index },
        })),
      ),
    ),
  },
});
it("uses Agent tool keys as aliases without mutating the reusable Tool", async () => {
  const original = createTool({ name: "original", description: "Shared tool", schema: z.object({}), execute: () => "result" });
  const harness = await AgentHarness.create({
    tools: { first: original, second: original },
    modelScripts: [{ response: { message: MessageCodec.encode(new AssistantMessage([
      { type: "tool-call", name: "second", toolCallId: "alias-call", arguments: {} },
    ])) } }, { text: "done" }],
  });
  try {
    expect(original.name).toBe("original");
    expect(harness.agent.listTool().map((tool) => tool.name)).toEqual(["first", "second"]);
    const result = await harness.agent.generate("use second");
    expect(result.status).toBe("completed");
    expect(harness.provider.calls[0]!.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect((await harness.records(result.streamId)).tools[0]!.toolName).toBe("second");
    expect(result.output.find((message) => message.role === "tool")!.content).toEqual([{ type: "text", text: "result" }]);
  } finally { await harness.dispose(); }
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function start(harness: AgentHarness) {
  const thread = await harness.createThread();
  const stream = harness.admit({
    kind: "input",
    threadId: thread.id,
    input: [MessageCodec.encode(new HumanMessage("work"))],
    model: { providerId: "scripted", modelId: "test" },
  });
  const collected = harness.collect(stream);
  // Attach immediately so an assertion failure never leaves an unhandled rejection.
  void collected.catch(() => {});
  return { thread, stream, collected };
}

it("executes direct and plugin tools together without a default concurrency limit", async () => {
  const gate = deferred(),
    started: number[] = [];
  let transforms = 0;
  const work = createTool({
    name: "work",
    description: "Work",
    schema: z.object({
      index: z.number().transform((value) => {
        transforms++;
        return value;
      }),
    }),
    execute: async ({ index }) => {
      started.push(index);
      await gate.promise;
      return new ToolMessage(String(index), {
        id: "result-" + index,
        metadata: { index },
      });
    },
  });
  const pluginTool = createTool({
    name: "plugin-work",
    description: "Plugin work",
    schema: z.object({}),
    execute: () => "plugin",
  });
  const script = response(5);
  const message = new AssistantMessage([
    ...script.response.message.content,
    {
      type: "tool-call",
      toolCallId: "plugin-call",
      name: "plugin-work",
      arguments: {},
    },
  ]);
  const harness = await AgentHarness.create({
    tools: { work },
    plugins: [
      {
        id: "extra",
        setup(tessar) {
          tessar.tools.register(pluginTool);
        },
      },
    ],
    modelScripts: [
      { response: { message: MessageCodec.encode(message) } },
      { text: "done" },
    ],
  });
  const execution = await start(harness);
  try {
    await expect.poll(() => started.length, { timeout: 1000 }).toBe(5);
    expect(harness.provider.calls).toHaveLength(1);
    gate.resolve();
    await execution.collected;
    const records = await harness.records(execution.stream.id!);
    expect(transforms).toBe(5);
    expect(records.tools.map((tool) => tool.status)).toEqual(
      Array(6).fill("succeeded"),
    );
    expect(harness.provider.calls[0]!.tools.map((tool) => tool.name)).toEqual([
      "work",
      "plugin-work",
    ]);
    expect(
      records.messages
        .filter((message) => message.role === "tool")
        .map((message) => [
          message.id,
          message.toolCallId,
          message.metadata?.index,
        ]),
    ).toEqual([
      ...Array.from({ length: 5 }, (_, index) => [
        "result-" + index,
        "call-" + index,
        index,
      ]),
      [expect.any(String), "plugin-call", undefined],
    ]);
  } finally {
    gate.resolve();
    await execution.collected.catch(() => {});
    await harness.dispose();
  }
});

it("limits active executions but publishes out-of-order completions in call order", async () => {
  const gates = Array.from({ length: 4 }, deferred),
    started: number[] = [];
  let active = 0,
    peak = 0;
  const work = createTool({
    name: "work",
    description: "Work",
    schema: z.object({ index: z.number() }),
    execute: async ({ index }) => {
      started.push(index);
      peak = Math.max(peak, ++active);
      await gates[index]!.promise;
      active--;
      return { index };
    },
  });
  const harness = await AgentHarness.create({
    tools: { concurrency: 2, work },
    modelScripts: [response(4), { text: "done" }],
  });
  const execution = await start(harness);
  try {
    await expect.poll(() => started.slice()).toEqual([0, 1]);
    gates[1]!.resolve();
    await expect.poll(() => started.slice()).toEqual([0, 1, 2]);
    gates[2]!.resolve();
    await expect.poll(() => started.slice()).toEqual([0, 1, 2, 3]);
    gates[3]!.resolve();
    gates[0]!.resolve();
    await execution.collected;
    expect(peak).toBe(2);
    expect(
      harness.provider.calls[1]!.messages.filter(
        (message) => message.role === "tool",
      ).map((message) => message.toolCallId),
    ).toEqual(["call-0", "call-1", "call-2", "call-3"]);
  } finally {
    gates.forEach((gate) => gate.resolve());
    await execution.collected.catch(() => {});
    await harness.dispose();
  }
});

it("suspends preparation before dispatch and resumes the right tool without repeating approvals", async () => {
  const Approval = defineInterruption({
    id: "batch-approval",
    version: 1,
    response: {
      jsonSchema: { type: "boolean" },
      parse: (value) => Boolean(value),
    },
    resolve: (value) =>
      value ? ToolDecision.allow() : ToolDecision.deny("denied"),
  });
  const seen: string[] = [],
    ran: number[] = [];
  const work = createTool({
    name: "work",
    description: "Work",
    schema: z.object({ index: z.number() }),
    execute: ({ index }) => {
      ran.push(index);
      return "done";
    },
  });
  const harness = await AgentHarness.create({
    tools: { work },
    modelScripts: [response(3), { text: "done" }],
    plugins: [
      {
        id: "approval",
        setup(tessar) {
          tessar.interruptions.register(Approval);
          tessar.hook(toolHooks.before, (event, context) => {
            seen.push(event.payload.toolCallId);
            return event.payload.toolCallId === "call-1"
              ? context.suspend(Approval, {})
              : ToolDecision.allow();
          });
        },
      },
    ],
  });
  try {
    const { thread, stream, collected } = await start(harness);
    const events = await collected;
    expect(ran).toEqual([]);
    const interrupt = events.find(
      (event) => event.type === streamHooks.suspended,
    )!;
    expect(interrupt).toBeDefined();
    await harness.collect(
      harness.admit({
        kind: "resume",
        threadId: thread.id,
        interruptId: interrupt.payload.interrupt.id,
        value: true,
      }),
    );
    expect(seen).toEqual(["call-0", "call-1", "call-2"]);
    expect(ran.sort()).toEqual([0, 1, 2]);
    expect((await harness.records(stream.id!)).stream.status).toBe("completed");
  } finally {
    await harness.dispose();
  }
});

it("recovers every dispatched tool and preserves completed siblings without redispatch", async () => {
  const executions: number[] = [],
    reconciled: number[] = [];
  const work = createTool({
    name: "work",
    description: "Work",
    schema: z.object({ index: z.number() }),
    execute: async ({ index }) => {
      executions.push(index);
      if (index !== 1)
        throw new TessarError("StorageUnavailable", "lost acknowledgement");
      return "saved sibling";
    },
    recovery: {
      idempotencyKey: (_, identity) => identity.toolExecutionId,
      reconcile: async ({ input }) => {
        reconciled.push(input.index);
        return { status: "completed", result: "reconciled " + input.index };
      },
    },
  });
  const harness = await AgentHarness.create({
    tools: { work },
    modelScripts: [response(3), { text: "done" }],
  });
  try {
    const { thread, stream, collected } = await start(harness);
    await expect(collected).rejects.toThrow("lost acknowledgement");
    await harness.collect(
      harness.admit({
        kind: "recover",
        threadId: thread.id,
        streamId: stream.id!,
      }),
    );
    expect(executions.sort()).toEqual([0, 1, 2]);
    expect(reconciled.sort()).toEqual([0, 2]);
    const records = await harness.records(stream.id!);
    expect(records.tools.map((tool) => tool.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(
      records.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId),
    ).toEqual(["call-0", "call-1", "call-2"]);
  } finally {
    await harness.dispose();
  }
});

it("rejects invalid concurrency and plugin registrations colliding with Agent tool aliases", async () => {
  const work = createTool({
    name: "work",
    description: "Work",
    schema: z.object({}),
    execute: () => "ok",
  });
  for (const concurrency of [0, -1, 1.5, NaN, Infinity])
    expect(
      () =>
        new Agent({
          id: "bad",
          model: { providerId: "test", modelId: "test" },
          tools: { concurrency, work },
        }),
    ).toThrow();
  const controller = new Controller({
    id: "duplicate",
    agent: new Agent({
      id: "agent",
      model: { providerId: "test", modelId: "test" },
      tools: { work },
    }),
  });
  try {
    await controller.initialize();
    await expect(
      controller.plugins.attach({
        id: "duplicate",
        setup(tessar) {
          tessar.tools.register(work);
        },
      }),
    ).rejects.toMatchObject({ code: "RegistrationConflict" });
  } finally {
    await controller.dispose();
  }
});

it("cancels concurrent calls without dispatching queued calls or replaying unknown outcomes", async () => {
  const gate = deferred(),
    started: number[] = [];
  const work = createTool({
    name: "work",
    description: "Work",
    schema: z.object({ index: z.number() }),
    execute: async ({ index }) => {
      started.push(index);
      await gate.promise;
      return "late";
    },
  });
  const harness = await AgentHarness.create({
    tools: { concurrency: 2, work },
    modelScripts: [response(4)],
  });
  const execution = await start(harness);
  try {
    await expect.poll(() => started.length).toBe(2);
    execution.stream.abort();
    await expect(execution.collected).rejects.toMatchObject({
      code: "RecoveryRequired",
    });
    expect(started).toEqual([0, 1]);
    expect(
      (await harness.records(execution.stream.id!)).tools.map(
        (tool) => tool.status,
      ),
    ).toEqual(["interrupted", "interrupted", "pending", "pending"]);
    await expect(
      harness.collect(
        harness.admit({
          kind: "recover",
          threadId: execution.thread.id,
          streamId: execution.stream.id!,
        }),
      ),
    ).rejects.toMatchObject({ code: "RecoveryRequired" });
    expect(started).toEqual([0, 1]);
  } finally {
    gate.resolve();
    await execution.collected.catch(() => {});
    await harness.dispose();
  }
});

it("attributes concurrent auxiliary calls to their own tool execution", async () => {
  const gate = deferred();
  let ready = 0;
  const model = { providerId: "scripted", modelId: "test" };
  const work = createTool({
    name: "work",
    description: "Work",
    schema: z.object({ index: z.number() }),
    execute: async ({ index }, context) => {
      if (++ready === 2) gate.resolve();
      await gate.promise;
      for await (const _ of context.models.stream({
        model,
        purpose: "auxiliary",
        request: {
          model,
          instructions: normalizeInstruction(String(index)),
          messages: [],
          tools: [],
        },
      })) {
      }
      return String(index);
    },
  });
  const harness = await AgentHarness.create({
    tools: { work },
    modelScripts: [
      response(2),
      { text: "aux-0" },
      { text: "aux-1" },
      { text: "done" },
    ],
  });
  const execution = await start(harness);
  try {
    await execution.collected;
    const records = await harness.records(execution.stream.id!);
    const parents = records.attempts
      .filter((attempt) => attempt.purpose === "auxiliary")
      .map((attempt) => attempt.parentToolExecutionId);
    expect(parents.sort()).toEqual(records.tools.map((tool) => tool.id).sort());
    expect(harness.provider.calls).toHaveLength(4);
  } finally {
    gate.resolve();
    await execution.collected.catch(() => {});
    await harness.dispose();
  }
});

it("keeps denied, invalid and missing results isolated to their own calls", async () => {
  const ran: number[] = [];
  const work = createTool({
    name: "work",
    description: "Work",
    schema: z.object({ index: z.number() }),
    execute: ({ index }) => {
      ran.push(index);
      return index === 2
        ? (undefined as never)
        : new ToolMessage("wrong correlation", { toolCallId: "other-call" });
    },
  });
  const harness = await AgentHarness.create({
    tools: { work },
    modelScripts: [response(4), { text: "done" }],
    plugins: [
      {
        id: "policy",
        setup(tessar) {
          tessar.hook(toolHooks.prepare, (event) =>
            event.payload.arguments.index === 1
              ? { ...event.payload, arguments: { index: "invalid" } }
              : undefined,
          );
          tessar.hook(toolHooks.before, (event) =>
            event.payload.arguments.index === 0
              ? ToolDecision.deny("no permission")
              : ToolDecision.allow(),
          );
        },
      },
    ],
  });
  try {
    const execution = await start(harness);
    await execution.collected;
    const records = await harness.records(execution.stream.id!);
    expect(ran.sort()).toEqual([2, 3]);
    expect(records.tools.map((tool) => tool.status)).toEqual([
      "denied",
      "failed",
      "failed",
      "failed",
    ]);
    expect(
      records.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId),
    ).toEqual(["call-0", "call-1", "call-2", "call-3"]);
    expect(records.stream.status).toBe("completed");
  } finally {
    await harness.dispose();
  }
});

it("keeps concurrent auxiliary requests inside the model-attempt budget", async () => {
  const model = { providerId: "scripted", modelId: "test" };
  const gate = deferred();
  let ready = 0;
  const work = createTool({
    name: "work",
    description: "Work",
    schema: z.object({ index: z.number() }),
    execute: async (_, context) => {
      if (++ready === 2) gate.resolve();
      await gate.promise;
      for await (const _ of context.models.stream({
        model,
        purpose: "auxiliary",
        request: {
          model,
          instructions: normalizeInstruction("aux"),
          messages: [],
          tools: [],
        },
      })) {
      }
      return "done";
    },
  });
  const harness = await AgentHarness.create({
    tools: { work },
    limits: { maxModelAttempts: 2 },
    modelScripts: [response(2), { text: "aux" }, { text: "must not call" }],
  });
  try {
    const execution = await start(harness);
    await execution.collected;
    expect(harness.provider.calls).toHaveLength(2);
    expect((await harness.records(execution.stream.id!)).attempts).toHaveLength(
      2,
    );
  } finally {
    await harness.dispose();
  }
});

it("accepts ToolMessage results from a plugin transform and binds their correlation", async () => {
  const work = createTool({
    name: "work",
    description: "Work",
    schema: z.object({ index: z.number() }),
    execute: () => "original",
  });
  const harness = await AgentHarness.create({
    tools: { work },
    modelScripts: [response(1), { text: "done" }],
    plugins: [
      {
        id: "result",
        setup(tessar) {
          tessar.hook(
            toolHooks.result,
            () =>
              new ToolMessage("transformed", {
                id: "transformed-result",
                metadata: { source: "plugin" },
              }),
          );
        },
      },
    ],
  });
  try {
    const execution = await start(harness);
    await execution.collected;
    expect(
      (await harness.records(execution.stream.id!)).messages.find(
        (message) => message.role === "tool",
      ),
    ).toMatchObject({
      id: "transformed-result",
      toolCallId: "call-0",
      metadata: { source: "plugin" },
    });
  } finally {
    await harness.dispose();
  }
});

it("rejects a result ID already used by a different message", async () => {
  const work = createTool({
    name: "work",
    description: "Work",
    schema: z.object({ index: z.number() }),
    execute: () => new ToolMessage("result", { id: "input-message" }),
  });
  const harness = await AgentHarness.create({
    tools: { work },
    modelScripts: [response(1), { text: "must not continue" }],
  });
  try {
    const thread = await harness.createThread();
    const stream = harness.admit({
      kind: "input",
      threadId: thread.id,
      input: [
        MessageCodec.encode(new HumanMessage("ask", { id: "input-message" })),
      ],
      model: { providerId: "scripted", modelId: "test" },
    });
    await harness.collect(stream);
    expect((await harness.records(stream.id!)).stream).toMatchObject({
      status: "failed",
      error: { code: "InvalidMessage" },
    });
    expect(harness.provider.calls).toHaveLength(1);
  } finally {
    await harness.dispose();
  }
});

it.each([1, 2])(
  "distinguishes cancellation before dispatch from active calls in a batch of %i",
  async (count) => {
    const cancellation = new AbortController(),
      gate = deferred(),
      ran: number[] = [];
    const work = createTool({
      name: "work",
      description: "Work",
      schema: z.object({ index: z.number() }),
      execute: async ({ index }) => {
        ran.push(index);
        await gate.promise;
        return "done";
      },
    });
    const harness = await AgentHarness.create({
      tools: { work },
      modelScripts: [response(count)],
      plugins: [
        {
          id: "cancel",
          setup(tessar) {
            tessar.hook(toolHooks.start, (event) => {
              if (event.payload.toolCallId === "call-" + (count - 1))
                cancellation.abort();
            });
          },
        },
      ],
    });
    try {
      const thread = await harness.createThread();
      const stream = harness.admit({
        kind: "input",
        threadId: thread.id,
        input: [MessageCodec.encode(new HumanMessage("ask"))],
        model: { providerId: "scripted", modelId: "test" },
        signal: cancellation.signal,
      });
      const collected = harness.collect(stream);
      if (count === 1) await collected;
      else
        await expect(collected).rejects.toMatchObject({
          code: "RecoveryRequired",
        });
      expect(ran).toEqual(count === 1 ? [] : [0]);
      const records = await harness.records(stream.id!);
      expect(records.tools.map((tool) => tool.status)).toEqual(
        count === 1 ? ["cancelled"] : ["interrupted", "pending"],
      );
    } finally {
      gate.resolve();
      await harness.dispose();
    }
  },
);
