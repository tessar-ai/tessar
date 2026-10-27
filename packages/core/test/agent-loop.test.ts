import {
  tool as toolHooks,
  model as modelHooks,
  turn as turnHooks,
  checkpoint as checkpointHooks,
  stream as streamHooks,
  input as inputHooks,
} from "../src/events/type.js";
import { z } from "zod";
import { expect, it } from "vitest";
import { AgentHarness } from "../src/testing/harness.js";
import { AssistantMessage, HumanMessage } from "../src/messages/message.js";
import { MessageCodec } from "../src/messages/codec.js";
import { createTool } from "../src/tools/tool.js";

it.each(["stop", "throw"] as const)(
  "enforces BeforeTool %s without executing the tool or continuing the model",
  async (mode) => {
    let executed = 0;
    const harness = await AgentHarness.create({
      modelScripts: [
        {
          response: {
            message: MessageCodec.encode(
              new AssistantMessage([
                {
                  type: "tool-call",
                  toolCallId: "write-1",
                  name: "write",
                  arguments: {},
                },
              ]),
            ),
          },
        },
        { text: "must not continue" },
      ],
      plugins: [
        {
          id: "policy",
          setup(tessar) {
            tessar.tools.register(
              createTool({
                name: "write",
                description: "write",
                schema: z.object({}),
                execute: async () => {
                  executed++;
                  return "written";
                },
              }),
            );
            tessar.hook(toolHooks.before, () => {
              if (mode === "throw") throw Error("policy unavailable");
              return { decision: "stop", reason: "policy stopped" };
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
          input: [MessageCodec.encode(new HumanMessage("write"))],
          model: { providerId: "scripted", modelId: "test" },
        });
      await harness.collect(stream);
      const records = await harness.records(stream.id!);
      expect(executed).toBe(0);
      expect(harness.provider.calls).toHaveLength(1);
      expect(records.stream).toMatchObject(
        mode === "stop"
          ? { status: "stopped", stopReason: "policy stopped" }
          : {
              status: "failed",
              error: {
                source: "plugin",
                pluginId: "policy",
                message: "policy unavailable",
              },
            },
      );
      expect(records.turns[0]!.status).toBe(
        mode === "stop" ? "stopped" : "failed",
      );
    } finally {
      await harness.dispose();
    }
  },
);
it.each(["failed", "cancelled"] as const)(
  "ends the active turn when its stream is %s",
  async (status) => {
    let abort!: () => void;
    const gate = new Promise<void>((resolve) => (abort = resolve));
    const harness = await AgentHarness.create({
      modelScripts: [
        status === "failed"
          ? { error: Error("provider failed") }
          : { gate, text: "never" },
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
      const events = [];
      for await (const event of stream) {
        events.push(event);
        if (status === "cancelled" && event.type === modelHooks.start)
          stream.abort();
      }
      const records = await harness.records(stream.id!);
      expect(records.stream.status).toBe(status);
      expect(records.turns[0]).toMatchObject({
        status,
        endedAt: expect.any(String),
        durationMs: expect.any(Number),
      });
      expect(
        events.filter((event) => event.type === turnHooks.end),
      ).toHaveLength(1);
    } finally {
      abort();
      await harness.dispose();
    }
  },
);
it("keeps checkpoint observers free of mutable execution services", async () => {
  let observed: Record<string, unknown> | undefined;
  const harness = await AgentHarness.create({
    modelScripts: [{ text: "done" }],
    plugins: [
      {
        id: "observer",
        setup(tessar) {
          tessar.hook(checkpointHooks.committed, (_e, context) => {
            observed = context;
          });
        },
      },
    ],
  });
  try {
    const thread = await harness.createThread();
    await harness.collect(
      harness.admit({
        kind: "input",
        threadId: thread.id,
        input: [MessageCodec.encode(new HumanMessage("ask"))],
        model: { providerId: "scripted", modelId: "test" },
      }),
    );
    expect(observed).toBeDefined();
    expect(observed!.state).toBeUndefined();
    expect(observed!.effects).toBeUndefined();
    expect(observed!.models).toBeUndefined();
    expect(observed!.suspend).toBeUndefined();
  } finally {
    await harness.dispose();
  }
});
it("runs model tools model with committed trace and one terminal event", async () => {
  let executed = 0;
  const tool = createTool({
    name: "lookup",
    description: "Lookup",
    schema: z.object({}),
    execute: async () => {
      executed++;
      return "found";
    },
  });
  const harness = await AgentHarness.create({
    plugins: [
      {
        id: "tools",
        setup(tessar) {
          tessar.tools.register(tool);
        },
      },
    ],
    modelScripts: [
      {
        response: {
          message: MessageCodec.encode(
            new AssistantMessage([
              {
                type: "tool-call",
                toolCallId: "c1",
                name: "lookup",
                arguments: {},
              },
            ]),
          ),
          finishReason: "tool_calls",
        },
      },
      { text: "answer", usage: { inputTokens: 10, outputTokens: 2 } },
    ],
  });
  try {
    const thread = await harness.createThread();
    const stream = harness.admit({
      kind: "input",
      threadId: thread.id,
      input: [MessageCodec.encode(new HumanMessage("ask"))],
      model: { providerId: "scripted", modelId: "test" },
    });
    const events = await harness.collect(stream),
      records = await harness.records(stream.id!);
    expect(executed).toBe(1);
    expect(harness.provider.calls).toHaveLength(2);
    expect(records.turns).toHaveLength(2);
    expect(records.attempts).toHaveLength(2);
    expect(records.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(records.stream!.status).toBe("completed");
    expect(events.filter((e) => e.type === streamHooks.end)).toHaveLength(1);
  } finally {
    await harness.dispose();
  }
});
it("handles input in a plugin without a model attempt", async () => {
  const harness = await AgentHarness.create({
    plugins: [
      {
        id: "commands",
        setup(tessar) {
          tessar.hook(inputHooks.prepare, (e) => ({
            ...e.payload,
            handled: {
              output: [MessageCodec.encode(new AssistantMessage("help"))],
            },
          }));
        },
      },
    ],
  });
  try {
    const thread = await harness.createThread(),
      stream = harness.admit({
        kind: "input",
        threadId: thread.id,
        input: [MessageCodec.encode(new HumanMessage("/help"))],
        model: { providerId: "scripted", modelId: "test" },
      });
    await harness.collect(stream);
    expect((await harness.records(stream.id!)).attempts).toHaveLength(0);
    expect(
      (await harness.records(stream.id!)).stream!.directUsage.metrics
        .totalTokens.knownTotal,
    ).toBe(0);
  } finally {
    await harness.dispose();
  }
});
it("stops a tool batch at the hard limit without dispatching the remainder or ending twice", async () => {
  let calls = 0;
  const tool = createTool({
    name: "lookup",
    description: "Lookup",
    schema: z.object({}),
    execute: async () => {
      calls++;
      return "ok";
    },
  });
  const harness = await AgentHarness.create({
    limits: { maxToolCalls: 1 },
    plugins: [
      {
        id: "tools",
        setup(tessar) {
          tessar.tools.register(tool);
        },
      },
    ],
    modelScripts: [
      {
        response: {
          message: MessageCodec.encode(
            new AssistantMessage([
              {
                type: "tool-call",
                toolCallId: "c1",
                name: "lookup",
                arguments: {},
              },
              {
                type: "tool-call",
                toolCallId: "c2",
                name: "lookup",
                arguments: {},
              },
            ]),
          ),
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
    const events = await harness.collect(stream);
    expect(calls).toBe(1);
    expect((await harness.records(stream.id!)).stream!.status).toBe("stopped");
    expect(events.filter((e) => e.type === streamHooks.end)).toHaveLength(1);
  } finally {
    await harness.dispose();
  }
});
it("keeps completed outcomes and usage when an end observer fails", async () => {
  const harness = await AgentHarness.create({
    modelScripts: [
      { text: "done", usage: { inputTokens: 3, outputTokens: 2 } },
    ],
    plugins: [
      {
        id: "finalizer",
        setup(tessar) {
          tessar.hook(streamHooks.end, () => {
            throw Error("flush failed");
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
    await harness.collect(stream);
    expect((await harness.records(stream.id!)).stream).toMatchObject({
      status: "completed",
      directUsage: { metrics: { totalTokens: { knownTotal: 5 } } },
    });
  } finally {
    await harness.dispose();
  }
});
