import {
  message as messageHooks,
  stream as streamHooks,
  turn as turnHooks,
} from "../../src/events/type.js";
import { z } from "zod";
import { expect, it } from "vitest";
import { createDelivery } from "../../src/engine/delivery.js";

import { randomIds } from "../../src/json.js";
import { AgentHarness } from "../../src/testing/harness.js";
import { defineInterruption } from "../../src/engine/interrupt.js";
import { ToolDecision } from "../../src/events/type.js";
import { AssistantMessage, HumanMessage } from "../../src/messages/message.js";
import { MessageCodec } from "../../src/messages/codec.js";
import { createTool } from "../../src/tools/tool.js";
it("retains a detached plugin until its asynchronous consumer-error hook settles", async () => {
  let release!: () => void, ended!: () => void, disposed = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const done = new Promise<void>((resolve) => { ended = resolve; });
  const h = await AgentHarness.create({ plugins: [{ id: "watch", setup(tessar) {
    tessar.hook("stream.error", async () => { await gate; });
    tessar.hook("stream.end", () => ended());
    tessar.defer(() => { disposed = true; });
  } }] });
  h.provider.stream = async function* () {
    for (let index = 0; index < 600; index++) yield { type: "message-delta", messageId: "answer", partId: "text", partKind: "text", delta: "x" };
    yield { type: "response", response: { message: MessageCodec.encode(new AssistantMessage("answer")) } };
  };
  try {
    h.agent.stream("hello");
    await done;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await h.controller.plugins.detach("watch");
    expect(disposed).toBe(false);
    release();
    await expect.poll(() => disposed).toBe(true);
  } finally { release(); await h.dispose(); }
});
it("publishes consumer overflow to hooks without cancelling its execution", async () => {
  const failures: import("../../src/events/definition.js").StreamEvent[] = [];
  let ended!: () => void;
  const done = new Promise<void>((resolve) => { ended = resolve; });
  const h = await AgentHarness.create({ modelScripts: [{ text: "x".repeat(600) }], plugins: [{ id: "watch", setup(tessar) {
    tessar.hook("stream.error", (event) => { failures.push(event); });
    tessar.hook("stream.end", () => ended());
  } }] });
  h.provider.stream = async function* () {
    for (let index = 0; index < 600; index++) yield { type: "message-delta", messageId: "answer", partId: "text", partKind: "text", delta: "x" };
    yield { type: "response", response: { message: MessageCodec.encode(new AssistantMessage("answer")) } };
  };
  try {
    const stream = h.agent.stream("hello");
    await done;
    const events = [];
    for await (const event of stream) events.push(event);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload).toMatchObject({ target: "consumer", error: { code: "ConsumerTooSlow" } });
    expect(failures[0]!.timestamp).toBe(events[0]!.timestamp);
    expect((await h.records(stream.id!)).stream.status).toBe("completed");
  } finally { await h.dispose(); }
});
it("detaches overflowing consumers at 512 events without cancelling execution", async () => {
  const delivery = createDelivery("t", randomIds, { kind: "iterator" });
  delivery.setId("s");
  for (let i = 0; i < 513; i++)
    delivery.emit(
      messageHooks.delta,
      {
        messageId: "m",
        partId: "p",
        partKind: "text",
        delta: "x",
        attemptId: "a",
      },
      {},
    );
  const events = [];
  for await (const event of delivery.stream) events.push(event);
  expect(events).toHaveLength(1);
  expect(
    events.find((event) => event.type === streamHooks.error)!.payload.error
      .code,
  ).toBe("ConsumerTooSlow");
  expect(delivery.controller.signal.aborted).toBe(false);
});
it("cancels a suspended execution and its pending interrupt durably", async () => {
  const Question = defineInterruption({
    id: "pause.question",
    version: 1,
    response: { jsonSchema: {}, parse: () => ({}) },
    resolve: () => ToolDecision.allow(),
  });
  const harness = await AgentHarness.create({
    plugins: [
      {
        id: "pause",
        setup(tessar) {
          tessar.interruptions.register(Question);
          tessar.hook(streamHooks.before, (_event, ctx) =>
            ctx.suspend(Question, {}),
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
    await harness.agent.cancel(thread.id, stream.id!);
    expect((await harness.records(stream.id!)).stream.status).toBe("cancelled");
    expect(
      (await harness.queries.getRecord("interrupts", thread.id, interrupt.id))!
        .status,
    ).toBe("cancelled");
  } finally {
    await harness.dispose();
  }
});
it("keeps an abort-ignoring in-flight tool interrupted instead of unlocking the thread", async () => {
  let started!: () => void, release!: () => void, errored!: () => void;
  const start = new Promise<void>((resolve) => (started = resolve)),
    done = new Promise<void>((resolve) => (errored = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
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
                started();
                await gate;
                return "late";
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
    ],
  });
  try {
    const thread = await harness.createThread(),
      stream = harness.admit(
        {
          kind: "input",
          threadId: thread.id,
          input: [MessageCodec.encode(new HumanMessage("ask"))],
          model: { providerId: "scripted", modelId: "test" },
        },
        {
          kind: "observer",
          observe: (event) => {
            if (event.type === streamHooks.error) errored();
          },
        },
      );
    await start;
    await harness.agent.cancel(thread.id, stream.id!);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error("Tool cancellation did not detach")),
            1000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    expect((await harness.records(stream.id!)).stream.status).toBe(
      "interrupted",
    );
  } finally {
    release();
    await harness.dispose();
  }
});
it("enforces the byte limit and detaches return without abortion", async () => {
  const delivery = createDelivery("t", randomIds, { kind: "iterator" });
  delivery.emit(
    messageHooks.delta,
    {
      messageId: "m",
      partId: "p",
      partKind: "text",
      delta: "x".repeat(4 * 1024 * 1024),
      attemptId: "a",
    },
    {},
  );
  expect(
    (await delivery.stream[Symbol.asyncIterator]().next()).value.payload.error
      .code,
  ).toBe("ConsumerTooSlow");
  expect(delivery.controller.signal.aborted).toBe(false);
  const other = createDelivery("t", randomIds, { kind: "iterator" }),
    iterator = other.stream[Symbol.asyncIterator]();
  await iterator.return!();
  expect(other.controller.signal.aborted).toBe(false);
  other.close();
});
it("does not allocate iterator queues for observers and ignores late emissions after close", () => {
  let events = 0;
  const delivery = createDelivery("t", randomIds, {
    kind: "observer",
    observe: () => {
      events++;
    },
  });
  for (let i = 0; i < 1000; i++)
    delivery.emit(turnHooks.start, { turnId: "t", index: i }, {});
  expect(events).toBe(1000);
  delivery.close();
  delivery.emit(turnHooks.start, { turnId: "t", index: 1001 }, {});
  expect(events).toBe(1000);
  delivery.stream.abort();
  expect(delivery.controller.signal.aborted).toBe(false);
});
it("reports sync and async observer failures without blocking later delivery", async () => {
  const errors: unknown[] = [],
    seen: number[] = [];
  const delivery = createDelivery(
    "t",
    randomIds,
    {
      kind: "observer",
      observe(event) {
        if (event.type !== turnHooks.start) return;
        seen.push(event.payload.index);
        if (event.payload.index === 0) throw Error("sync observer");
        if (event.payload.index === 1)
          return Promise.reject(Error("async observer"));
      },
    },
    undefined,
    (error) => {
      errors.push(error);
    },
  );
  for (let index = 0; index < 3; index++)
    delivery.emit(turnHooks.start, { turnId: "turn", index }, {});
  expect(seen).toEqual([0, 1, 2]);
  await Promise.resolve();
  expect(errors).toMatchObject([
    {
      source: "application",
      eventId: turnHooks.start,
      message: "sync observer",
    },
    {
      source: "application",
      eventId: turnHooks.start,
      message: "async observer",
    },
  ]);
  expect(delivery.controller.signal.aborted).toBe(false);
  delivery.close();
});
