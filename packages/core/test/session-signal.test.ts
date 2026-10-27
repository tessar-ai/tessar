import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  Agent,
  Controller,
  HumanMessage,
  AssistantMessage,
  MessageCodec,
  createMemoryBackend,
  createTool,
  defineInterruption,
  input,
  stream,
  type StreamEvent,
} from "../src/index.js";
import { ScriptedProvider } from "../src/testing/scripted-provider.js";

it("receives a closing Thread's next message without making its hook wait", async () => {
  const provider = new ScriptedProvider([
    { text: "first" },
    { text: "second" },
  ]);
  const agent = new Agent({ id: "signal-closing-thread", model: provider });
  let sent = false;
  const controller = new Controller({
    id: "signal-closing-thread",
    agent,
    plugins: [
      {
        id: "closing",
        setup(tessar) {
          tessar.hook(stream.end, async (_event, context) => {
            if (!sent && typeof context.threadId === "string") {
              sent = true;
              await agent.sendSignal({
                threadId: context.threadId,
                content: "next notification",
              });
            }
          });
        },
      },
    ],
  });
  await controller.initialize();
  try {
    const session = await controller.createSession(),
      thread = await session.thread.create();
    let completed = 0;
    session.subscribe(stream.end, () => {
      completed++;
    });
    await session.followUp("first input");
    await vi.waitFor(() => expect(completed).toBe(2));
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.messages.at(-1)!.content).toEqual([
      { type: "text", text: "next notification" },
    ]);
    expect(
      (await thread.getHistory()).items.filter(
        (message) => message.role === "user",
      ),
    ).toHaveLength(2);
  } finally {
    await controller.dispose();
  }
});

it("coordinates suspended signal writes with an in-flight resume", async () => {
  const backend = createMemoryBackend();
  const ask = createTool({
    name: "ask",
    description: "ask",
    schema: z.object({}),
    execute: (_input, context) => context.suspend("question"),
  });
  const provider = new ScriptedProvider([
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
    { text: "done" },
  ]);
  const agent = new Agent({
    id: "signal-resume-race",
    model: provider,
    tools: { ask },
  });
  const controller = new Controller({
    id: "signal-resume-race",
    agent,
    plugins: [
      {
        id: "storage",
        setup(tessar) {
          tessar.storage.register(backend);
        },
      },
    ],
  });
  await controller.initialize();
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const entered = new Promise<void>((done) => {
    reached = done;
  });
  let resuming: Promise<unknown> | undefined;
  try {
    const session = await controller.createSession(),
      thread = await session.thread.create();
    const events: StreamEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });
    await session.followUp("ask");
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === stream.suspended)).toBe(
        true,
      ),
    );
    const interrupt = events.find((event) => event.type === stream.suspended)!
      .payload.interrupt;
    const get = backend.checkpoints.get.bind(backend.checkpoints);
    let pause = true;
    vi.spyOn(backend.checkpoints, "get").mockImplementation(async (id) => {
      const value = await get(id);
      if (pause) {
        pause = false;
        reached();
        await gate;
      }
      return value;
    });
    resuming = session.resume({ interruptId: interrupt.id, value: "answer" });
    void resuming.catch(() => {});
    await entered;
    await agent.sendSignal({ threadId: thread.id, content: "during resume" });
    await new Promise<void>((done) => setImmediate(done));
    release();
    await resuming;
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === stream.end)).toBe(true),
    );
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain(
      "during resume",
    );
  } finally {
    release();
    await resuming?.catch(() => {});
    await controller.dispose();
  }
});

it("starts an idle selected thread through its Session subscription and model options", async () => {
  const provider = new ScriptedProvider([{ text: "done" }]);
  const agent = new Agent({ id: "session-signal-idle", model: provider });
  const controller = new Controller({ id: "session-signal-idle", agent });
  await controller.initialize();
  try {
    const session = await controller.createSession();
    await session.thread.create();
    await session.model.switch("other", { temperature: 0.2 });
    const events: StreamEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });
    await agent.sendSignal({
      threadId: session.thread.getId()!,
      content: "notification",
      persist: false,
    });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "stream.end")).toBe(true),
    );
    expect(provider.calls[0]!.model.modelId).toBe("other");
    expect(provider.calls[0]!.options).toMatchObject({ temperature: 0.2 });
    expect(provider.calls[0]!.messages[0]!.content).toEqual([
      { type: "text", text: "notification" },
    ]);
    expect(JSON.stringify(await session.thread.getHistory())).not.toContain(
      "notification",
    );
  } finally {
    await controller.dispose();
  }
});

it("accepts signals while suspended without resuming and delivers after the waiting tool result", async () => {
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
  const provider = new ScriptedProvider([
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
    { text: "done" },
  ]);
  const agent = new Agent({
    id: "session-signal-waiting",
    model: provider,
    tools: { ask },
  });
  const controller = new Controller({ id: "session-signal-waiting", agent });
  await controller.initialize();
  try {
    const session = await controller.createSession();
    const thread = await session.thread.create();
    const events: StreamEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });
    await session.followUp(new HumanMessage("ask"));
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "stream.suspended")).toBe(
        true,
      ),
    );
    const suspended = events.find(
      (event) => event.type === "stream.suspended",
    )!;
    if (suspended.type !== "stream.suspended") throw Error("missing interrupt");
    await agent.sendSignal({ threadId: thread.id, content: "durable" });
    await agent.sendSignal({
      threadId: thread.id,
      content: "temporary",
      persist: false,
    });
    expect(provider.calls).toHaveLength(1);
    expect(
      (await thread.getInterrupt(suspended.payload.interrupt.id))!.status,
    ).toBe("pending");
    await session.resume({
      interruptId: suspended.payload.interrupt.id,
      value: "answer",
    });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "stream.end")).toBe(true),
    );
    expect(provider.calls[1]!.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
      "user",
    ]);
    expect(executions).toBe(1);
    expect(JSON.stringify(await thread.getHistory())).toContain("durable");
    expect(JSON.stringify(await thread.getHistory())).not.toContain(
      "temporary",
    );
  } finally {
    await controller.dispose();
  }
});

it("rejects ambiguous idle Session ownership and releases disposed handles", async () => {
  const agent = new Agent({
    id: "signal-ambiguous",
    model: new ScriptedProvider([{ text: "done" }]),
  });
  const controller = new Controller({ id: "signal-ambiguous", agent });
  await controller.initialize();
  try {
    const one = await controller.createSession();
    const thread = await one.thread.create();
    const two = await controller.createSession();
    await two.thread.switch(thread.id);
    await expect(
      agent.sendSignal({ threadId: thread.id, content: "ambiguous" }),
    ).rejects.toMatchObject({ code: "SessionBusy" });
    await two.dispose();
    await agent.sendSignal({ threadId: thread.id, content: "accepted" });
    await expect(
      agent.sendSignal({ threadId: "missing", content: "unknown" }),
    ).rejects.toThrow();
  } finally {
    await controller.dispose();
  }
});

it("rejects stale Session handles, unselected Threads and cross-scope selection", async () => {
  const agent = new Agent({
    id: "signal-stale",
    model: new ScriptedProvider([]),
  });
  const controller = new Controller({ id: "signal-stale", agent });
  await controller.initialize();
  try {
    const one = await controller.createSession({ scope: { user: "one" } });
    const thread = await one.thread.create();
    const restored = (await controller.getSession(one.id))!;
    await restored.thread.create();
    await expect(
      agent.sendSignal({ threadId: thread.id, content: "stale" }),
    ).rejects.toMatchObject({ code: "CommitConflict" });
    await one.dispose();
    const other = await controller.createSession({ scope: { user: "other" } });
    await expect(other.thread.switch(thread.id)).rejects.toThrow();
    await expect(
      agent.sendSignal({ threadId: thread.id, content: "not selected" }),
    ).rejects.toMatchObject({ code: "ThreadNotSelected" });
  } finally {
    await controller.dispose();
  }
});

it("never checkpoints transient initial input in stream.before decision cursors", async () => {
  const provider = new ScriptedProvider([{ text: "done" }]);
  const agent = new Agent({ id: "signal-transient-policy", model: provider });
  const controller = new Controller({
    id: "signal-transient-policy",
    agent,
    plugins: [
      {
        id: "policy",
        setup(tessar) {
          tessar.hook(stream.before, () => ({ decision: "allow" }));
        },
      },
    ],
  });
  await controller.initialize();
  try {
    const session = await controller.createSession(),
      thread = await session.thread.create();
    const events: StreamEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });
    await agent.sendSignal({
      threadId: thread.id,
      content: "PRIVATE_CURSOR_MARKER",
      persist: false,
    });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === stream.end)).toBe(true),
    );
    expect(JSON.stringify(provider.calls)).toContain("PRIVATE_CURSOR_MARKER");
    expect(
      JSON.stringify(await controller.backend.checkpoints.list(thread.id)),
    ).not.toContain("PRIVATE_CURSOR_MARKER");
  } finally {
    await controller.dispose();
  }
});

it("finishes handled transient initial input without calling the provider", async () => {
  const provider = new ScriptedProvider([]);
  const agent = new Agent({ id: "signal-transient-handled", model: provider });
  const controller = new Controller({
    id: "signal-transient-handled",
    agent,
    plugins: [
      {
        id: "handled",
        setup(tessar) {
          tessar.hook(input.prepare, (event) => ({
            ...event.payload,
            handled: {
              output: [
                MessageCodec.encode(new AssistantMessage("handled locally")),
              ],
            },
          }));
        },
      },
    ],
  });
  await controller.initialize();
  try {
    const session = await controller.createSession(),
      thread = await session.thread.create();
    const events: StreamEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });
    await agent.sendSignal({
      threadId: thread.id,
      content: "PRIVATE_HANDLED_MARKER",
      persist: false,
    });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === stream.end)).toBe(true),
    );
    expect(provider.calls).toHaveLength(0);
    expect(
      events.find((event) => event.type === stream.end)!.payload.status,
    ).toBe("completed");
    expect(JSON.stringify(await thread.getHistory())).toContain(
      "handled locally",
    );
    expect(
      JSON.stringify(await controller.backend.checkpoints.list(thread.id)),
    ).not.toContain("PRIVATE_HANDLED_MARKER");
  } finally {
    await controller.dispose();
  }
});

it("retains transient stream.before input only in memory when resuming later handlers", async () => {
  const provider = new ScriptedProvider([{ text: "done" }]);
  const agent = new Agent({ id: "signal-transient-before", model: provider });
  const approval = defineInterruption({
    id: "approval",
    version: 1,
    response: { jsonSchema: {}, parse: () => ({}) },
    resolve: () => ({ decision: "allow" as const }),
  });
  let inspected = false;
  const controller = new Controller({
    id: "signal-transient-before",
    agent,
    plugins: [
      {
        id: "approve",
        setup(tessar) {
          tessar.interruptions.register(approval);
          tessar.hook(stream.before, (_event, context) =>
            context.suspend(approval, { question: "continue?" }),
          );
          tessar.hook(stream.before, (event) => {
            inspected = JSON.stringify(event.payload.input).includes(
              "PRIVATE_RESUME_MARKER",
            );
          });
        },
      },
    ],
  });
  await controller.initialize();
  try {
    const session = await controller.createSession(),
      thread = await session.thread.create();
    const events: StreamEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });
    await agent.sendSignal({
      threadId: thread.id,
      content: "PRIVATE_RESUME_MARKER",
      persist: false,
    });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === stream.suspended)).toBe(
        true,
      ),
    );
    const pending = events.find((event) => event.type === stream.suspended)!
      .payload.interrupt;
    expect(
      JSON.stringify(await controller.backend.checkpoints.list(thread.id)),
    ).not.toContain("PRIVATE_RESUME_MARKER");
    await session.resume({ interruptId: pending.id, value: {} });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === stream.end)).toBe(true),
    );
    expect(inspected).toBe(true);
    expect(JSON.stringify(provider.calls)).toContain("PRIVATE_RESUME_MARKER");
    expect(
      JSON.stringify(await controller.backend.checkpoints.list(thread.id)),
    ).not.toContain("PRIVATE_RESUME_MARKER");
  } finally {
    await controller.dispose();
  }
});
