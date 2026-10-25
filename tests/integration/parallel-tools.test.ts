import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AgentHarness } from "@tessar/core/testing";
import {
  AssistantMessage,
  HumanMessage,
  MessageCodec,
  TessarError,
  ToolMessage,
  createTool,
} from "@tessar/core";
import { createSqliteBackend } from "@tessar/sqlite";

it("recovers SQLite tool results committed before their messages without repeating external work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tessar-parallel-"));
  const backend = await createSqliteBackend({
    filename: join(directory, "state.db"),
  });
  const originalStage = backend.commits.stage;
  let failed = false,
    executed = 0;
  backend.commits.stage = async (batch) => {
    if (
      !failed &&
      batch.checkpoint.cause === "MessageCommitted" &&
      batch.checkpoint.state.messages.at(-1)?.role === "tool"
    ) {
      failed = true;
      throw new TessarError("StorageUnavailable", "failed message publication");
    }
    await originalStage(batch);
  };
  const work = createTool({
    name: "work",
    description: "Work",
    schema: z.object({ index: z.number() }),
    execute: async ({ index }) => {
      executed++;
      return new ToolMessage([{ type: "data", data: { index } }], {
        id: "result-" + index,
        metadata: { index },
      });
    },
  });
  const harness = await AgentHarness.create({
    backend,
    tools: { work },
    modelScripts: [
      {
        response: {
          message: MessageCodec.encode(
            new AssistantMessage(
              [0, 1, 2].map((index) => ({
                type: "tool-call",
                name: "work",
                toolCallId: "call-" + index,
                arguments: { index },
              })),
            ),
          ),
        },
      },
      { text: "done" },
    ],
  });
  try {
    const thread = await harness.createThread();
    const stream = harness.admit({
      kind: "input",
      threadId: thread.id,
      input: [MessageCodec.encode(new HumanMessage("work"))],
      model: { providerId: "scripted", modelId: "test" },
    });
    await expect(harness.collect(stream)).rejects.toMatchObject({
      code: "StorageUnavailable",
    });
    expect(executed).toBe(3);
    const saved = await harness.records(stream.id!);
    expect(saved.tools.every((tool) => tool.result !== null)).toBe(true);
    expect(
      saved.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(0);
    await harness.collect(
      harness.admit({
        kind: "recover",
        threadId: thread.id,
        streamId: stream.id!,
      }),
    );
    expect(executed).toBe(3);
    const records = await harness.records(stream.id!);
    expect(records.stream.status).toBe("completed");
    expect(
      records.messages
        .filter((message) => message.role === "tool")
        .map((message) => [
          message.id,
          message.toolCallId,
          message.metadata?.index,
        ]),
    ).toEqual(
      [0, 1, 2].map((index) => ["result-" + index, "call-" + index, index]),
    );
    expect(harness.provider.calls).toHaveLength(2);
    expect(
      (await backend.checkpoints.list(thread.id)).every(
        (checkpoint) =>
          checkpoint.execution?.phase !== "ToolPending" ||
          checkpoint.execution.pendingToolExecutionIds.length > 0,
      ),
    ).toBe(true);
  } finally {
    await harness.dispose();
    await backend.close();
    const target = resolve(directory);
    if (
      !target.startsWith(resolve(tmpdir()) + "\\") &&
      !target.startsWith(resolve(tmpdir()) + "/")
    )
      throw Error("Unsafe cleanup target");
    await rm(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
