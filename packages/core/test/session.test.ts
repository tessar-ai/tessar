import { createThread } from "../src/state/thread-operations.js";
import {
  session as sessionHooks,
  thread as threadHooks,
  stream as streamHooks,
  model as modelHooks,
} from "../src/index.js";
import { expect, it } from "vitest";
import {
  HumanMessage,
  defineInterruption,
  ToolDecision,
  createMemoryBackend,
} from "../src/index.js";
import { fixture } from "./test-fixture.js";

function boundary(session: import("../src/session.js").Session, type: string) {
  return new Promise<any>((resolve) => {
    const off = session.subscribe((event) => {
      if (event.type === type) {
        off();
        resolve(event);
      }
    });
  });
}
it("isolates sync and async subscribers while delivering the same session event", async () => {
  const { controller } = await fixture();
  try {
    const session = await controller.createSession(),
      seen: string[] = [];
    session.subscribe(threadHooks.started, () => {
      throw Error("sync subscriber");
    });
    session.subscribe(threadHooks.started, async () => {
      throw Error("async subscriber");
    });
    session.subscribe(threadHooks.started, (event) => {
      seen.push(event.payload.id);
    });
    const thread = await session.thread.create();
    expect(seen).toEqual([thread.id]);
    expect(controller.diagnostics).toMatchObject([
      {
        source: "application",
        eventId: threadHooks.started,
        message: "sync subscriber",
      },
      {
        source: "application",
        eventId: threadHooks.started,
        message: "async subscriber",
      },
    ]);
  } finally {
    await controller.dispose();
  }
});
it("closes despite observer errors and rejects work during and after disposal", async () => {
  const { controller, provider } = await fixture(
    [{ text: "ok" }],
    [
      {
        id: "close",
        setup(tessar) {
          tessar.hook(sessionHooks.closed, () => { throw Error("close observer failed"); });
        },
      },
    ],
  );
  try {
    const session = await controller.createSession();
    await session.thread.create();
    const closing = session.dispose();
    await expect(
      session.followUp(new HumanMessage("during close")),
    ).rejects.toMatchObject({ code: "Disposed" });
    await expect(session.thread.create()).rejects.toMatchObject({
      code: "Disposed",
    });
    expect(provider.calls).toHaveLength(0);
    await closing;
    expect(session.isDisposed()).toBe(true);
    expect(controller.diagnostics.some(error => error.message === "close observer failed")).toBe(true);
    await expect(
      session.followUp(new HumanMessage("after close")),
    ).rejects.toMatchObject({ code: "Disposed" });
  } finally {
    await controller.dispose();
  }
});
it("routes events per Session and drains accepted input FIFO after closing the prior attachment", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const created: string[] = [];
  const { controller, provider } = await fixture(
    [{ text: "one", gate }, { text: "two" }],
    [
      {
        id: "creation",
        setup(tessar) {
          tessar.hook(sessionHooks.created, (_event, ctx) => {
            created.push(ctx.sessionId!);
          });
        },
      },
    ],
  );
  try {
    const a = await controller.createSession({ scope: { user: "u" } }),
      b = await controller.createSession({ scope: { user: "u" } });
    expect(created).toEqual([a.id, b.id]);
    await a.thread.create();
    expect(b.thread.getId()).toBeNull();
    let otherEvents = 0;
    b.subscribe(() => {
      otherEvents++;
    });
    const first = a.followUp(new HumanMessage("first"));
    await first;
    await a.model.switch("scripted/second");
    const second = await a.followUp(new HumanMessage("second"));
    expect(second.threadId).toBe(a.thread.getId());
    await expect(a.thread.create()).rejects.toMatchObject({
      code: "SessionBusy",
    });
    await expect(a.dispose()).rejects.toMatchObject({ code: "SessionBusy" });
    const done = new Promise<void>((resolve) => {
      let count = 0;
      const off = a.subscribe(streamHooks.end, () => {
        if (++count === 2) {
          off();
          resolve();
        }
      });
    });
    release();
    await done;
    expect(
      provider.calls.map(
        (c) => c.messages.filter((m) => m.role === "user").at(-1)?.content[0],
      ),
    ).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    expect(provider.calls.map((c) => c.model.modelId)).toEqual([
      "test",
      "second",
    ]);
    expect(otherEvents).toBe(0);
  } finally {
    release();
    await controller.dispose();
  }
});
it("holds queued input while suspended, preserves it on invalid resume, then drains", async () => {
  const question = defineInterruption({
    id: "approve",
    version: 1,
    response: {
      jsonSchema: { type: "boolean" },
      parse(value) {
        if (typeof value !== "boolean") throw Error("boolean required");
        return value;
      },
    },
    resolve: () => ToolDecision.allow(),
  });
  let asks = 0;
  const { controller, provider } = await fixture(
    [{ text: "one" }, { text: "two" }],
    [
      {
        id: "approval",
        setup(tessar) {
          tessar.interruptions.register(question);
          tessar.hook(streamHooks.before, (_e, context) =>
            ++asks === 1 ? context.suspend(question, {}) : ToolDecision.allow(),
          );
        },
      },
    ],
  );
  try {
    const session = await controller.createSession();
    await session.thread.create();
    const pending = boundary(session, streamHooks.suspended);
    await session.followUp(new HumanMessage("one"));
    await session.followUp(new HumanMessage("two"));
    const event = await pending;
    expect(provider.calls).toHaveLength(0);
    await expect(
      session.resume({
        interruptId: event.payload.interrupt.id,
        value: "wrong",
      }),
    ).rejects.toMatchObject({ code: "InvalidResumeResponse" });
    expect(provider.calls).toHaveLength(0);
    const done = new Promise<void>((resolve) => {
      let count = 0;
      const off = session.subscribe(streamHooks.end, () => {
        if (++count === 2) {
          off();
          resolve();
        }
      });
    });
    const receipt = await session.resume({
      interruptId: event.payload.interrupt.id,
      value: true,
    });
    expect(receipt.streamId).toBe(event.streamId);
    await done;
    expect(provider.calls).toHaveLength(2);
  } finally {
    await controller.dispose();
  }
});
it("accepts a follow-up from a terminal observer after releasing the prior lease", async () => {
  const backend = createMemoryBackend(),
    releaseLease = backend.ownership.release.bind(backend.ownership);
  let hold = false,
    unlock!: () => void,
    arrive!: () => void;
  const held = new Promise<void>((r) => (unlock = r)),
    reached = new Promise<void>((r) => (arrive = r));
  backend.ownership.release = async (lease) => {
    if (hold) {
      hold = false;
      arrive();
      await held;
    }
    return releaseLease(lease);
  };
  const { controller, provider } = await fixture(
    [{ text: "one" }, { text: "two" }],
    [
      {
        id: "slow-release",
        setup(tessar) {
          tessar.storage.register(backend);
        },
      },
    ],
  );
  try {
    const session = await controller.createSession();
    await session.thread.create();
    const done = new Promise<void>((resolve, reject) => {
      let turns = 0;
      session.subscribe((event) => {
        if (event.type === streamHooks.error)
          reject(Error(event.payload.error.code));
        if (event.type === streamHooks.end) {
          if (++turns === 1) {
            hold = true;
            void session.followUp(new HumanMessage("two"));
          } else resolve();
        }
      });
    });
    void done.catch(() => {});
    await session.followUp(new HumanMessage("one"));
    await reached;
    await new Promise((r) => setImmediate(r));
    unlock();
    await done;
    expect(provider.calls).toHaveLength(2);
  } finally {
    unlock();
    await controller.dispose();
  }
});
it("discards queued input on cancellation and preserves selection when switching fails", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { controller, provider } = await fixture([{ gate, text: "never" }]);
  try {
    const session = await controller.createSession({ scope: { user: "a" } });
    const thread = await session.thread.create();
    const foreign = await createThread(controller, { scope: { user: "b" } });
    await expect(session.thread.switch(foreign.id)).rejects.toMatchObject({
      code: "ThreadNotFound",
    });
    expect(session.thread.getId()).toBe(thread.id);
    const started = boundary(session, modelHooks.start);
    await session.followUp(new HumanMessage("first"));
    await started;
    await session.followUp(new HumanMessage("queued"));
    const discarded = boundary(session, sessionHooks.inputDiscarded);
    await session.abort();
    expect((await discarded).payload.cause).toBe("cancelled");
    expect(provider.calls).toHaveLength(1);
  } finally {
    release();
    await controller.dispose();
  }
});
it("forks without selecting and allows suspended state to survive Session disposal and reattachment", async () => {
  const question = defineInterruption({
    id: "pause",
    version: 1,
    response: { jsonSchema: {}, parse: () => ({}) },
    resolve: () => ToolDecision.allow(),
  });
  const { controller } = await fixture(
    [{ text: "done" }],
    [
      {
        id: "pause",
        setup(tessar) {
          tessar.interruptions.register(question);
          tessar.hook(streamHooks.before, (_e, ctx) =>
            ctx.suspend(question, {}),
          );
        },
      },
    ],
  );
  try {
    const session = await controller.createSession({ scope: { user: "u" } }),
      thread = await session.thread.create();
    const fork = await session.thread.fork();
    expect(fork.id).not.toBe(thread.id);
    expect(session.thread.getId()).toBe(thread.id);
    const pending = boundary(session, streamHooks.suspended);
    await session.followUp(new HumanMessage("ask"));
    const event = await pending;
    await session.dispose();
    const next = await controller.createSession({ scope: { user: "u" } });
    await next.thread.switch(thread.id);
    const done = boundary(next, streamHooks.end);
    const receipt = await next.resume({
      interruptId: event.payload.interrupt.id,
      value: {},
    });
    expect(receipt.streamId).toBe(event.streamId);
    await done;
    if (false) {
      const sessionId: string = next.id;
      // @ts-expect-error Session uses subscription
      next.stream({});
      // @ts-expect-error only Controller initializes
      next.initialize();
      // @ts-expect-error no per-operation scope override
      next.thread.create({ scope: { user: "other" } });
    }
  } finally {
    await controller.dispose();
  }
});
