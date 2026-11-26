import { model as modelHooks, stream as streamHooks } from "../../src/events/type.js";
import { z } from "zod";
import { expect, it } from "vitest";
import { AgentHarness } from "../../src/testing/harness.js";
import { TessarError } from "../../src/errors.js";
import { AssistantMessage, HumanMessage } from "../../src/messages/message.js";
import { MessageCodec } from "../../src/messages/codec.js";
import { createTool } from "../../src/tools/tool.js";
import { createMemoryBackend } from "../../src/state/memory-backend.js";

it("reuses a committed model response instead of issuing it again after attachment failure", async () => {
  let tools = 0,
    failNext = false;
  const backend = createMemoryBackend(),
    stage = backend.commits.stage;
  backend.commits.stage = async (batch) => {
    if (failNext) {
      failNext = false;
      throw new TessarError("StorageUnavailable", "simulated crash");
    }
    await stage(batch);
    if (
      batch.checkpoint.cause === "MessageCommitted" &&
      batch.checkpoint.state.messages.at(-1)?.role === "assistant" &&
      batch.checkpoint.execution?.phase === "BeforeTool"
    )
      failNext = true;
  };
  const harness = await AgentHarness.create({
    backend,
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
                tools++;
                return "done";
              },
            }),
          );
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
                toolCallId: "c",
                name: "write",
                arguments: {},
              },
            ]),
          ),
        },
      },
      { text: "final" },
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
    await expect(harness.collect(stream)).rejects.toMatchObject({
      code: "StorageUnavailable",
    });
    expect(tools).toBe(0);
    expect(harness.provider.calls).toHaveLength(1);
    await harness.collect(
      harness.admit({
        kind: "recover",
        threadId: thread.id,
        streamId: stream.id!,
      }),
    );
    expect(tools).toBe(1);
    expect(harness.provider.calls).toHaveLength(2);
    expect((await harness.records(stream.id!)).stream.status).toBe("completed");
  } finally {
    await harness.dispose();
  }
});
it("recovers an interrupted model attempt only with policy and preserves retry accounting", async () => {
  const backend = createMemoryBackend(),
    stage = backend.commits.stage;
  let failCleanup = false,
    armed = false;
  backend.commits.stage = async (batch) => {
    if (failCleanup) {
      failCleanup = false;
      throw new TessarError(
        "StorageUnavailable",
        "crash before error checkpoint",
      );
    }
    await stage(batch);
    if (
      !armed &&
      batch.checkpoint.execution?.phase === "ModelPending" &&
      batch.records.some(
        (r) => r.kind === "model_attempts" && r.data.status === "running",
      )
    ) {
      failCleanup = true;
      armed = true;
    }
  };
  const harness = await AgentHarness.create({
    backend,
    plugins: [
      {
        id: "retry",
        setup(tessar) {
          tessar.hook(modelHooks.recover, () => ({
            decision: "retry" as const,
          }));
        },
      },
    ],
    modelScripts: [
      { error: new TessarError("ProviderError", "failed") },
      { text: "done" },
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
    await expect(harness.collect(stream)).rejects.toThrow();
    await harness.collect(
      harness.admit({
        kind: "recover",
        threadId: thread.id,
        streamId: stream.id!,
      }),
    );
    const records = await harness.records(stream.id!);
    expect(records.attempts.map((a) => a.status)).toEqual([
      "interrupted",
      "succeeded",
    ]);
    expect(records.attempts[1]!.callId).toBe(records.attempts[0]!.callId);
    expect(records.attempts[1]!.attemptIndex).toBe(1);
  } finally {
    await harness.dispose();
  }
});
it("reconciles a completed external tool without dispatching it again", async () => {
  let effects = 0;
  const harness = await AgentHarness.create({
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
                effects++;
                throw new TessarError("StorageUnavailable", "ack lost");
              },
              recovery: {
                idempotencyKey: (_input, identity) => identity.toolExecutionId,
                reconcile: async () => ({
                  status: "completed",
                  result: "already wrote",
                }),
              },
            }),
          );
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
  });
  try {
    const thread = await harness.createThread(),
      stream = harness.admit({
        kind: "input",
        threadId: thread.id,
        input: [MessageCodec.encode(new HumanMessage("ask"))],
        model: { providerId: "scripted", modelId: "test" },
      });
    await expect(harness.collect(stream)).rejects.toThrow();
    await harness.collect(
      harness.admit({
        kind: "recover",
        threadId: thread.id,
        streamId: stream.id!,
      }),
    );
    expect(effects).toBe(1);
    expect((await harness.records(stream.id!)).tools[0]!.status).toBe(
      "succeeded",
    );
  } finally {
    await harness.dispose();
  }
});
it("closes recovery with an unknown tool result and accepts another message in the same thread", async () => {
  let effects = 0;
  let reconciled = 0;
  const cancellation = Promise.withResolvers<void>();
  const harness = await AgentHarness.create({
    plugins: [
      {
        id: "tools",
        setup(tessar) {
          tessar.tools.register(
            createTool({
              name: "write",
              description: "write",
              schema: z.object({}),
              recovery: {
                idempotencyKey: (_, { toolExecutionId }) => toolExecutionId,
                reconcile: async () => {
                  reconciled++;
                  return { status: "unknown" };
                },
              },
              execute: async () => {
                effects++;
                throw new TessarError(
                  "StorageUnavailable",
                  "lost external acknowledgement",
                );
              },
            }),
          );
          tessar.hook(streamHooks.cancel, () => cancellation.promise);
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
                toolCallId: "c",
                name: "write",
                arguments: {},
              },
            ]),
          ),
        },
      },
      { text: "next answer" },
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
    await expect(harness.collect(stream)).rejects.toThrow();
    const session = await harness.controller.createSession();
    await session.thread.switch(thread.id);
    const recoveredReceipt = await session.recover({ streamId: stream.id! });
    expect(recoveredReceipt.streamId).toBe(stream.id);
    expect(reconciled).toBe(1);
    expect(harness.provider.calls).toHaveLength(1);
    await session.followUp("Read the previous outcome");
    cancellation.resolve();
    await expect.poll(() => harness.provider.calls.length).toBe(2);
    const recovered = await harness.records(stream.id!);
    expect(recovered.stream).toMatchObject({
      status: "cancelled",
      stopReason: "ToolOutcomeUnknown",
    });
    expect(recovered.tools[0]).toMatchObject({ status: "interrupted", result: { toolCallId: "c" } });
    expect(session.thread.getId()).toBe(thread.id);
    expect(harness.provider.calls[1]?.messages).toContainEqual(expect.objectContaining({
      role: "tool", toolCallId: "c",
      content: [{ type: "text", text: expect.stringContaining("effects may already have been applied") }],
    }));
    expect(effects).toBe(1);
  } finally {
    cancellation.resolve();
    await harness.dispose();
  }
});
