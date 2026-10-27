import { start, delta as partDelta, end } from "./part-fixture.js";
import { text as textEvents } from "../src/events/type.js";
import { expect, it } from "vitest";
import {
  Agent,
  AssistantMessage,
  HumanMessage,
  MessageCodec,
  createTool,
  stream,
} from "../src/index.js";
import type { RuntimeState } from "../src/runtime-state.js";
import { ScriptedProvider } from "../src/testing/scripted-provider.js";
import { fixture } from "./test-fixture.js";
import { z } from "zod";

const text = (state: RuntimeState) =>
  state.messages.flatMap((message) =>
    message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text),
  );

it("publishes immutable incremental snapshots from a standalone stream", async () => {
  const model = new ScriptedProvider([
    {
      chunks: [
        start("answer", "reason", "reasoning"),
        partDelta("answer", "Think", "reason", "reasoning"),
        start("answer", "text", "text", 1),
        partDelta("answer", "Hel", "text", "text", 1),
        partDelta("answer", "lo", "text", "text", 1),
        end("answer", "Think", "reason", "reasoning"),
        end("answer", "Hello", "text", "text", 1),
      ],
      response: {
        message: MessageCodec.encode(
          new AssistantMessage(
            [
              { type: "reasoning", text: "Think" },
              { type: "text", text: "Hello" },
            ],
            { id: "answer" },
          ),
        ),
      },
    },
  ]);
  const agent = new Agent({ id: crypto.randomUUID(), model });
  const snapshots: RuntimeState[] = [];
  for await (const event of agent.stream("Hi")) {
    if (event.type === "state_changed") snapshots.push(event.payload.state);
  }
  expect(snapshots.length).toBeGreaterThan(0);
  const partial = snapshots.find((state) => text(state).includes("Hel"))!;
  expect(partial).toBeDefined();
  expect(Object.isFrozen(partial.messages)).toBe(true);
  expect(text(partial)).toContain("Hel");
  expect(text(snapshots.at(-1)!)).toEqual(["Hi", "Hello"]);
  expect(snapshots.at(-1)!.status).toBe("completed");
  expect(snapshots.at(-1)!.currentMessage).toBeNull();
});

it("creates and selects a scoped Thread and keeps a Session snapshot across queued turns", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { controller, provider } = await fixture([
    { text: "one", gate },
    { text: "two" },
  ]);
  try {
    expect(controller.isReady()).toBe(true);
    const session = await controller.createSession({
      threadId: "quick-thread",
      scope: { user: "a" },
    });
    expect(session.thread.getId()).toBe("quick-thread");
    expect((await session.thread.get("quick-thread"))!.scope()).toEqual({
      user: "a",
    });
    expect(session.state.get()).toMatchObject({
      status: "idle",
      queuedInputs: 0,
    });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let completed = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "state_changed") {
        expect(event.payload.state).toBe(session.state.get());
      }
      if (event.type === stream.end && ++completed === 2) finish();
    });
    await session.followUp("first");
    await expect.poll(() => provider.calls.length).toBe(1);
    expect(session.isIdle()).toBe(false);
    await session.followUp("second");
    expect(session.followUp.count()).toBe(1);
    expect(session.followUp.isEmpty()).toBe(false);
    expect(session.state.get().queuedInputs).toBe(1);
    release();
    await done;
    await expect.poll(() => session.isIdle()).toBe(true);
    expect(text(session.state.get())).toEqual([
      "first",
      "one",
      "second",
      "two",
    ]);
    expect(session.followUp.isEmpty()).toBe(true);
    const stored = await controller.getSession(session.id);
    expect(text(stored!.state.get())).toEqual([
      "first",
      "one",
      "second",
      "two",
    ]);
    unsubscribe();
    await session.dispose();
    expect(session.isDisposed()).toBe(true);
    await expect(
      controller.createSession({ threadId: "quick-thread" }),
    ).rejects.toMatchObject({ code: "RegistrationConflict" });
  } finally {
    release();
    await controller.dispose();
  }
  expect(controller.isReady()).toBe(false);
});

it("projects tool progress and committed output without requiring a Session", async () => {
  const tool = createTool({
    name: "search",
    description: "Search",
    schema: z.object({}),
    execute: async (_input, context) => {
      context.emit({ found: 1 });
      return "result";
    },
  });
  const model = new ScriptedProvider([
    {
      response: {
        message: MessageCodec.encode(
          new AssistantMessage([
            {
              type: "tool-call",
              toolCallId: "call",
              name: "search",
              arguments: {},
            },
          ]),
        ),
      },
    },
    { text: "done" },
  ]);
  const agent = new Agent({
    id: crypto.randomUUID(),
    model,
    tools: { search: tool },
  });
  const states: RuntimeState[] = [];
  for await (const event of agent.stream(new HumanMessage("search")))
    if (event.type === "state_changed") states.push(event.payload.state);
  expect(
    states.some((state) =>
      state.tools.some(
        (tool) =>
          tool.progress &&
          typeof tool.progress === "object" &&
          "found" in tool.progress &&
          tool.progress.found === 1,
      ),
    ),
  ).toBe(true);
  expect(states.at(-1)!.tools[0]).toMatchObject({
    toolCallId: "call",
    name: "search",
    status: "succeeded",
  });
  expect(text(states.at(-1)!)).toEqual(["search", "result", "done"]);
});

it("isolates simultaneous streams and replaces state when selecting another Thread", async () => {
  const model = new ScriptedProvider([{ text: "A" }, { text: "B" }]);
  const agent = new Agent({ id: crypto.randomUUID(), model });
  const executions = [agent.stream("one"), agent.stream("two")];
  const results = await Promise.all(
    executions.map(async (execution) => {
      let state: RuntimeState | undefined;
      for await (const event of execution)
        if (event.type === "state_changed") {
          expect(event.streamId).toBe(execution.id);
          state = event.payload.state;
        }
      return text(state!);
    }),
  );
  expect(results).toEqual([
    ["one", "A"],
    ["two", "B"],
  ]);
  const { controller } = await fixture();
  try {
    const session = await controller.createSession();
    const first = await session.thread.create({
      messages: [new HumanMessage("old")],
    });
    await session.thread.create({ messages: [new HumanMessage("new")] });
    expect(text(session.state.get())).toEqual(["new"]);
    await session.thread.switch(first.id);
    expect(text(session.state.get())).toEqual(["old"]);
    await session.thread.delete();
    expect(session.state.get().messages).toEqual([]);
  } finally {
    await controller.dispose();
  }
});

it("restores suspended tools and resumes the same conversation without duplicate messages", async () => {
  const ask = createTool({
    name: "ask",
    description: "Ask",
    schema: z.object({}),
    execute: (_input, context) => context.suspend({ question: "Which?" }),
  });
  const { controller } = await fixture(
    [
      {
        response: {
          message: MessageCodec.encode(
            new AssistantMessage([
              {
                type: "tool-call",
                toolCallId: "question",
                name: "ask",
                arguments: {},
              },
            ]),
          ),
        },
      },
      { text: "answered" },
    ],
    [
      {
        id: "ask-tool",
        setup(tessar) {
          tessar.tools.register(ask);
        },
      },
    ],
  );
  try {
    const session = await controller.createSession({ threadId: "ask-thread" });
    let paused!: () => void;
    const suspended = new Promise<void>((resolve) => {
      paused = resolve;
    });
    session.subscribe((event) => {
      if (
        event.type === "state_changed" &&
        event.payload.state.status === "suspended"
      )
        paused();
    });
    await session.followUp("ask");
    await suspended;
    expect(session.isIdle()).toBe(true);
    expect(session.state.get().tools[0]!.status).toBe("suspended");
    const restored = await controller.getSession(session.id);
    const state = restored!.state.get();
    expect(state.status).toBe("suspended");
    expect(state.tools[0]!.status).toBe("suspended");
    expect(state.interrupt).not.toBeNull();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    restored!.subscribe(stream.end, () => finish());
    await restored!.resume({ interruptId: state.interrupt!.id, value: "yes" });
    await done;
    expect(text(restored!.state.get())).toEqual(["ask", "yes", "answered"]);
    expect(restored!.state.get().tools[0]!.status).toBe("succeeded");
  } finally {
    await controller.dispose();
  }
});

it("delivers text before the provider finishes and preserves detailed events", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = false;
  const model = {
    ref: { providerId: "live", modelId: "test" },
    validate() {},
    async *stream() {
      yield start("live-answer");
      yield partDelta("live-answer", "Hel", "text", "text");
      await gate;
      finished = true;
      yield end("live-answer", "Hello");
      yield {
        type: "response" as const,
        response: {
          message: MessageCodec.encode(
            new AssistantMessage("Hello", { id: "live-answer" }),
          ),
        },
      };
    },
  };
  const agent = new Agent({ id: crypto.randomUUID(), model });
  let partial = false,
    delta = false;
  try {
    for await (const event of agent.stream("Hi")) {
      if (event.type === textEvents.delta) delta = true;
      if (
        event.type === "state_changed" &&
        text(event.payload.state).includes("Hel")
      ) {
        expect(finished).toBe(false);
        partial = true;
        release();
      }
    }
    expect(partial && delta && finished).toBe(true);
  } finally {
    release();
  }
});

it("projects prepared input and removes failed drafts before a retry", async () => {
  const { controller } = await fixture(
    [
      {
        chunks: [
          start("failed"),
          partDelta("failed", "discard", "text", "text"),
        ],
        error: Error("retry"),
      },
      { text: "recovered" },
    ],
    [
      {
        id: "retry",
        setup(tessar) {
          tessar.hook("message.prepare", (event) =>
            event.payload.role === "user"
              ? {
                  ...event.payload,
                  content: [{ type: "text", text: "prepared" }],
                }
              : event.payload,
          );
          tessar.hook("model.recover", () => ({ decision: "retry" }));
        },
      },
    ],
  );
  try {
    const session = await controller.createSession({
      threadId: "retry-thread",
    });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    session.subscribe(stream.end, () => finish());
    await session.followUp("original");
    await done;
    expect(text(session.state.get())).toEqual(["prepared", "recovered"]);
    expect(session.state.get().error).toBeNull();
    expect(session.state.get()).not.toHaveProperty("threadId");
    expect(session.state.get()).not.toHaveProperty("streamId");
  } finally {
    await controller.dispose();
  }
});

it("makes state notifications available to plugins with the Session handle", async () => {
  const seen: boolean[] = [];
  const { controller } = await fixture(
    [{ text: "answer" }],
    [
      {
        id: "state-observer",
        setup(tessar) {
          tessar.hook("state_changed", (event, context) => {
            if (event.sessionId)
              seen.push(context.session?.state.get() === event.payload.state);
          });
        },
      },
    ],
  );
  try {
    const session = await controller.createSession({ threadId: "hook-thread" });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    session.subscribe(stream.end, () => finish());
    await session.followUp("hello");
    await done;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  } finally {
    await controller.dispose();
  }
});
