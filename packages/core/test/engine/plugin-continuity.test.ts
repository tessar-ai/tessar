import {
  stream as streamHooks,
  model as modelHooks,
} from "../../src/events/type.js";
import { z } from "zod";
import { expect, it } from "vitest";
import { AgentHarness } from "../../src/testing/harness.js";
import { ToolDecision } from "../../src/events/type.js";
import { defineInterruption } from "../../src/engine/interrupt.js";
import { HumanMessage } from "../../src/messages/message.js";
import { MessageCodec } from "../../src/messages/codec.js";
import { AssistantMessage } from "../../src/messages/message.js";
import { createTool } from "../../src/tools/tool.js";
it("rejects changed input schemas for ordinary plugin tools when resuming", async () => {
  const approval = defineInterruption({
    id: "approval", version: 1,
    response: { jsonSchema: {}, parse: () => ({}) }, resolve: () => ToolDecision.allow(),
  });
  const plugin = (changed: boolean) => ({
    id: "work", setup(tessar: import("../../src/plugins/context.js").PluginContext) {
      tessar.tools.register(createTool({ name: "work", description: "Work",
        schema: changed ? z.object({ extra: z.string().optional() }) : z.object({}), execute: () => "ok" }));
    },
  });
  const harness = await AgentHarness.create({
    plugins: [plugin(false), { id: "policy", setup(tessar) {
      tessar.interruptions.register(approval);
      tessar.hook("tool.before", (_event, context) => context.suspend(approval, {}));
    } }],
    modelScripts: [{ response: { message: MessageCodec.encode(new AssistantMessage([
      { type: "tool-call", toolCallId: "work", name: "work", arguments: {} },
    ])) } }, { text: "done" }],
  });
  try {
    const pending = await harness.agent.generate("work");
    await harness.controller.plugins.detach("work");
    await harness.controller.plugins.attach(plugin(true));
    await expect(harness.collect(harness.agent.resume({
      threadId: pending.threadId, interruptId: pending.interrupt!.id, value: {},
    }))).rejects.toMatchObject({ code: "ResumeIncompatible" });
  } finally { await harness.dispose(); }
});

it("keeps custom capabilities for the entire stream and cleans up after the final reader", async () => {
  let release!: () => void,
    started!: () => void,
    disposed = 0;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    entered = new Promise<void>((resolve) => (started = resolve));
  const old = { name: "old" },
    replacement = { name: "new" },
    seen: string[] = [];
  const harness = await AgentHarness.create({
    modelScripts: [{ text: "one" }, { text: "two" }],
    plugins: [
      {
        id: "memory",
        setup(tessar) {
          tessar.registry.register("memory", "project", old);
          tessar.defer(() => {
            disposed++;
          });
        },
      },
      {
        id: "consumer",
        setup(tessar) {
          tessar.hook(streamHooks.before, async (_event, context) => {
            started();
            await gate;
            seen.push(
              context.registry.get<typeof old>("memory", "project")!.name,
            );
          });
          tessar.hook(streamHooks.end, (_event, context) => {
            seen.push(
              context.registry.get<typeof old>("memory", "project")!.name,
            );
          });
        },
      },
    ],
  });
  try {
    const pending = harness.agent.generate("first");
    await entered;
    await harness.registry.detach("memory");
    expect(disposed).toBe(0);
    await harness.registry.attach({
      id: "replacement",
      setup(tessar) {
        tessar.registry.register("memory", "project", replacement);
      },
    });
    release();
    expect((await pending).status).toBe("completed");
    expect(seen).toEqual(["old", "old"]);
    expect(disposed).toBe(1);
    expect((await harness.agent.generate("second")).status).toBe("completed");
    expect(seen).toEqual(["old", "old", "new", "new"]);
  } finally {
    release();
    await harness.dispose();
  }
});
it("keeps suspended state when its required policy plugin is removed", async () => {
  const Question = defineInterruption({
    id: "policy.question",
    version: 1,
    response: { jsonSchema: {}, parse: () => ({}) },
    resolve: () => ToolDecision.allow(),
  });
  const harness = await AgentHarness.create({
    plugins: [
      {
        id: "policy",
        setup(tessar) {
          tessar.interruptions.register(Question);
          tessar.hook(streamHooks.before, (_event, context) =>
            context.suspend(Question, {}),
          );
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
      interrupt = events.find((e) => e.type === streamHooks.suspended)!.payload
        .interrupt;
    await harness.registry.detach("policy");
    const errorCode = await harness
      .collect(
        harness.admit({
          kind: "resume",
          threadId: thread.id,
          interruptId: interrupt.id,
          value: {},
        }),
      )
      .then(
        () => null,
        (error) => error.code,
      );
    expect(errorCode).toBe("ResumeIncompatible");
    expect(
      (await harness.queries.getRecord("interrupts", thread.id, interrupt.id))!
        .status,
    ).toBe("pending");
  } finally {
    await harness.dispose();
  }
});
it("keeps captured executors alive and applies newly attached policy only to new streams", async () => {
  let release!: () => void,
    started!: () => void,
    calls = 0,
    disposed = 0,
    policyCalls = 0;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    entered = new Promise<void>((resolve) => (started = resolve));
  const harness = await AgentHarness.create({
    modelScripts: [
      {
        gate,
        response: {
          message: MessageCodec.encode(
            new AssistantMessage([
              {
                type: "tool-call",
                toolCallId: "c",
                name: "work",
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
        id: "work",
        setup(tessar) {
          tessar.tools.register(
            createTool({
              name: "work",
              description: "work",
              schema: z.object({}),
              execute: async () => {
                calls++;
                return "ok";
              },
            }),
          );
          return () => {
            disposed++;
          };
        },
      },
    ],
  });
  try {
    await harness.registry.attach({
      id: "signals",
      setup(tessar) {
        tessar.hook(modelHooks.start, () => started());
      },
    });
    const thread = await harness.createThread(),
      stream = harness.admit({
        kind: "input",
        threadId: thread.id,
        input: [MessageCodec.encode(new HumanMessage("ask"))],
        model: { providerId: "scripted", modelId: "test" },
      });
    const completion = harness.collect(stream);
    await entered;
    await harness.registry.attach({
      id: "new-policy",
      setup(tessar) {
        tessar.hook(streamHooks.before, () => {
          policyCalls++;
          return ToolDecision.deny("blocked");
        });
      },
    });
    await harness.registry.detach("work");
    expect(disposed).toBe(0);
    release();
    await completion;
    expect(calls).toBe(1);
    expect(disposed).toBe(1);
    expect(policyCalls).toBe(0);
    const other = await harness.createThread(),
      blocked = harness.admit({
        kind: "input",
        threadId: other.id,
        input: [MessageCodec.encode(new HumanMessage("blocked"))],
        model: { providerId: "scripted", modelId: "test" },
      });
    await harness.collect(blocked);
    expect(policyCalls).toBe(1);
    expect((await harness.records(blocked.id!)).stream.status).toBe("stopped");
  } finally {
    release();
    await harness.dispose();
  }
});
it("rejects changed plugin configuration before consuming a pending response", async () => {
  const Question = defineInterruption({
    id: "configured.question",
    version: 1,
    response: { jsonSchema: {}, parse: () => ({}) },
    resolve: () => ToolDecision.allow(),
  });
  const plugin = (configurationId: string) => ({
    id: "configured",
    configurationId,
    setup(tessar: import("../../src/plugins/context.js").PluginContext) {
      tessar.interruptions.register(Question);
      tessar.hook(streamHooks.before, (_event, context) =>
        context.suspend(Question, {}),
      );
    },
  });
  const harness = await AgentHarness.create({
    modelScripts: [{ text: "done" }],
    plugins: [plugin("original")],
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
      interrupt = events.find((e) => e.type === streamHooks.suspended)!.payload
        .interrupt;
    await harness.registry.detach("configured");
    await harness.registry.attach(plugin("changed"));
    await expect(
      harness.collect(
        harness.admit({
          kind: "resume",
          threadId: thread.id,
          interruptId: interrupt.id,
          value: {},
        }),
      ),
    ).rejects.toMatchObject({ code: "ResumeIncompatible" });
    expect(
      (await harness.queries.getRecord("interrupts", thread.id, interrupt.id))!
        .status,
    ).toBe("pending");
  } finally {
    await harness.dispose();
  }
});
