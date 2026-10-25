import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  Agent,
  Controller,
  HumanMessage,
  AssistantMessage,
  MessageCodec,
  createTool,
  stream,
  type Session,
} from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { SqliteStoragePlugin } from "@tessar/sqlite";

function next(
  session: Session,
  type: typeof stream.suspended | typeof stream.end,
) {
  return new Promise<any>((resolve, reject) => {
    const off = session.subscribe((event) => {
      if (event.type === type) {
        off();
        resolve(event);
      }
      if (event.type === stream.error) {
        off();
        reject(event.payload.error);
      }
    });
  });
}

it("persists accepted suspended signals across SQLite restart without replay or transient leakage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tessar-signals-")),
    filename = join(directory, "state.db");
  let executions = 0;
  const ask = createTool({
    name: "ask",
    description: "ask",
    schema: z.object({}),
    execute: (_input, context) => {
      executions++;
      return context.suspend("question");
    },
  });
  async function open(resumed: boolean) {
    const provider = new ScriptedProvider(
      resumed
        ? [{ text: "done" }, { text: "next" }]
        : [
            {
              response: {
                message: MessageCodec.encode(
                  new AssistantMessage([
                    {
                      type: "tool-call",
                      name: "ask",
                      toolCallId: "call",
                      arguments: {},
                    },
                  ]),
                ),
              },
            },
          ],
    );
    const agent = new Agent({
      id: "signal-persistence",
      model: provider,
      tools: { ask },
    });
    const controller = new Controller({
      id: "signal-persistence",
      agent,
      plugins: [new SqliteStoragePlugin({ filename })],
    });
    await controller.initialize();
    return { controller, agent, provider };
  }
  let current = await open(false);
  try {
    let session = await current.controller.createSession({
      id: "session",
      scope: { user: "one" },
    });
    const thread = await session.thread.create({ id: "thread" });
    const suspended = next(session, stream.suspended);
    await session.followUp(new HumanMessage("ask"));
    const event = await suspended;
    await current.agent.sendSignal({
      threadId: thread.id,
      content: "durable",
      metadata: { source: "external" },
    });
    await current.agent.sendSignal({
      threadId: thread.id,
      content: "TRANSIENT_ONLY",
      persist: false,
    });
    expect(current.provider.calls).toHaveLength(1);
    await vi.waitFor(async () =>
      expect((await thread.snapshot()).execution!.pendingSignals).toHaveLength(
        1,
      ),
    );
    expect(
      JSON.stringify(
        await current.controller.backend.checkpoints.list(thread.id),
      ),
    ).not.toContain("TRANSIENT_ONLY");
    await session.dispose();
    await current.controller.dispose();

    current = await open(true);
    session = (await current.controller.getSession("session", {
      scope: { user: "one" },
    }))!;
    // Also exercise reception on a restored suspended Thread without a live frame.
    await current.agent.sendSignal({
      threadId: "thread",
      content: "after-restart",
    });
    const done = next(session, stream.end);
    await session.resume({
      interruptId: event.payload.interrupt.id,
      value: "answer",
    });
    const result = await done;
    expect(result.streamId).toBe(event.streamId);
    const sent = current.provider.calls[0]!.messages;
    expect(sent.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
      "user",
    ]);
    expect(JSON.stringify(sent)).not.toContain("TRANSIENT_ONLY");
    expect(
      sent.filter((message) => message.metadata?.source === "external"),
    ).toHaveLength(1);
    expect(executions).toBe(1);
    const history = await session.thread.getHistory();
    expect(
      history.items.filter(
        (message) => message.metadata?.source === "external",
      ),
    ).toHaveLength(1);
    const checkpoints =
      await current.controller.backend.checkpoints.list("thread");
    for (const cp of checkpoints) {
      const inHistory = cp.state.messages.some(
        (message) => message.metadata?.source === "external",
      );
      const pending =
        cp.execution?.pendingSignals?.some(
          (message) => message.metadata?.source === "external",
        ) ?? false;
      expect(inHistory && pending).toBe(false);
    }
    const again = next(session, stream.end);
    await session.followUp(new HumanMessage("next"));
    await again;
    expect(
      current.provider.calls[1]!.messages.filter(
        (message) => message.metadata?.source === "external",
      ),
    ).toHaveLength(1);
    await session.dispose();
  } finally {
    await current.controller.dispose();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
