import { z } from "zod";
import { expect, it } from "vitest";
import { AgentHarness } from "../../src/testing/harness.js";
import { defineEffect } from "../../src/engine/tracked-effects.js";
import { AssistantMessage, HumanMessage } from "../../src/messages/message.js";
import { MessageCodec } from "../../src/messages/codec.js";
import { createTool } from "../../src/tools/tool.js";
import { normalizeInstruction } from "../../src/instructions/instruction.js";
import { TessarError } from "../../src/errors.js";
import { Agent } from "../../src/agent.js";
import { ScriptedProvider } from "../../src/testing/scripted-provider.js";
const call = () => ({
  response: {
    message: MessageCodec.encode(
      new AssistantMessage([
        { type: "tool-call", toolCallId: "c", name: "work", arguments: {} },
      ]),
    ),
    usage: undefined,
  },
});
const model = { providerId: "scripted", modelId: "test" };
it("tracks auxiliary model attempts under their originating tool", async () => {
  const harness = await AgentHarness.create({
    modelScripts: [
      call(),
      { text: "aux", usage: { inputTokens: 20, outputTokens: 2 } },
      { text: "done", usage: { inputTokens: 10, outputTokens: 1 } },
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
              execute: async (_input, context) => {
                for await (const _chunk of context.models.stream({
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
                return "aux completed";
              },
            }),
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
        model,
      });
    await harness.collect(stream);
    const records = await harness.records(stream.id!);
    expect(records.attempts.map((a) => a.purpose)).toEqual([
      "primary",
      "auxiliary",
      "primary",
    ]);
    expect(records.attempts[1]!.parentToolExecutionId).toBe(
      records.tools[0]!.id,
    );
    expect(records.stream.directUsage.metrics.inputTokens.knownTotal).toBe(30);
    expect(records.tools[0]!.status).toBe("succeeded");
  } finally {
    await harness.dispose();
  }
});
it("requires reconciliation for unknown effects and does not invoke the executor again", async () => {
  let calls = 0;
  const errors: string[] = [];
  const Effect = defineEffect({
    id: "effect.unknown",
    version: 1,
    input: { jsonSchema: {}, parse: () => ({}) },
    output: { jsonSchema: {}, parse: () => ({}) },
    execute: async () => {
      calls++;
      throw new TessarError("StorageUnavailable", "external ack lost");
    },
  });
  const harness = await AgentHarness.create({
    modelScripts: [call(), { text: "done" }],
    plugins: [
      {
        id: "work",
        setup(tessar) {
          tessar.effects.register(Effect);
          tessar.tools.register(
            createTool({
              name: "work",
              description: "work",
              schema: z.object({}),
              execute: async (_input, context) => {
                for (let n = 0; n < 2; n++)
                  try {
                    await context.effects.execute(Effect, {}, { key: "once" });
                  } catch (error) {
                    errors.push((error as TessarError).code);
                  }
                return "unknown outcome was reported to host";
              },
            }),
          );
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
        model,
      }),
    );
    expect(calls).toBe(1);
    expect(errors).toEqual(["RecoveryRequired", "RecoveryRequired"]);
  } finally {
    await harness.dispose();
  }
});
it("commits typed effect outcomes and reuses completed results by stable key", async () => {
  let writes = 0;
  const Effect = defineEffect({
    id: "effect.write",
    version: 1,
    input: {
      jsonSchema: {},
      parse: (value: unknown) => value as { value: number },
    },
    output: {
      jsonSchema: {},
      parse: (value: unknown) => value as { value: number },
    },
    execute: async (input) => {
      writes++;
      return { value: input.value + 1 };
    },
  });
  const harness = await AgentHarness.create({
    modelScripts: [call(), { text: "done" }],
    plugins: [
      {
        id: "work",
        setup(tessar) {
          tessar.effects.register(Effect);
          tessar.tools.register(
            createTool({
              name: "work",
              description: "work",
              schema: z.object({}),
              execute: async (_input, context) => {
                expect(
                  await context.effects.execute(
                    Effect,
                    { value: 1 },
                    { key: "once" },
                  ),
                ).toEqual({ value: 2 });
                expect(
                  await context.effects.execute(
                    Effect,
                    { value: 1 },
                    { key: "once" },
                  ),
                ).toEqual({ value: 2 });
                await expect(
                  context.effects.execute(
                    Effect,
                    { value: 9 },
                    { key: "once" },
                  ),
                ).rejects.toMatchObject({ code: "CommitConflict" });
                return "done";
              },
            }),
          );
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
      model,
    });
    await harness.collect(stream);
    expect(writes).toBe(1);
    const effectStatuses = (await harness.backend.checkpoints.list(thread.id))
      .flatMap((checkpoint) => checkpoint.state.pluginStates)
      .filter((state) => state.namespace === "$effect:effect.write")
      .flatMap((state) => Object.values(state.data as Record<string, { status: string }>))
      .map((record) => record.status);
    expect(effectStatuses).toContain("dispatched");
    expect(effectStatuses).toContain("completed");
    expect(effectStatuses).not.toContain("pending");
    expect((await harness.records(stream.id!)).tools[0]!.status).toBe(
      "succeeded",
    );
  } finally {
    await harness.dispose();
  }
});
it("lets plugins compose independent agents without a core child-execution protocol", async () => {
  let hookHasExecutions = false,
    toolHasExecutions = false;
  const worker = new Agent({
    id: "independent-worker",
    model: new ScriptedProvider([
      { text: "worker result", usage: { inputTokens: 20, outputTokens: 0 } },
    ]),
  });
  const harness = await AgentHarness.create({
    modelScripts: [
      { ...call(), usage: { inputTokens: 10, outputTokens: 0 } },
      { text: "done", usage: { inputTokens: 0, outputTokens: 0 } },
    ],
    plugins: [
      {
        id: "work",
        setup(tessar) {
          tessar.agent.register(worker);
          tessar.hook("context.prepare", (event, context) => {
            hookHasExecutions ||= "executions" in context;
            return event.payload;
          });
          tessar.tools.register(
            createTool({
              name: "work",
              description: "work",
              schema: z.object({}),
              execute: async (_input, context) => {
                toolHasExecutions = "executions" in context;
                const result = await worker.generate("independent task");
                expect(result.usage.metrics.inputTokens.knownTotal).toBe(20);
                return "worker completed";
              },
            }),
          );
        },
      },
    ],
  });
  try {
    const thread = await harness.createThread();
    const stream = harness.admit({
      kind: "input",
      threadId: thread.id,
      input: [MessageCodec.encode(new HumanMessage("parent"))],
      model,
    });
    await harness.collect(stream);
    const records = await harness.records(stream.id!);
    expect(records.stream.status).toBe("completed");
    expect(records.stream.directUsage.metrics.inputTokens.knownTotal).toBe(10);
    expect(hookHasExecutions).toBe(false);
    expect(toolHasExecutions).toBe(false);
    expect(records.stream).not.toHaveProperty("inclusiveUsage");
    expect(records.stream).not.toHaveProperty("parentStreamId");
    expect(records.tools[0]!.status).toBe("succeeded");
  } finally {
    await harness.dispose();
  }
});
