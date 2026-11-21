import { expect, it, vi } from "vitest";
import { HumanMessage, MessageCodec, model, stream, session as sessionHooks } from "../src/index.js";
import { AgentHarness } from "../src/testing/harness.js";
import { ThreadService } from "../src/state/threads.js";

it("switches using one scoped target read and one fresh hydration read", async () => {
  const h = await AgentHarness.create();
  try {
    const session = await h.controller.createSession({ scope: { user: "one" } });
    const target = await session.thread.create({ messages: [new HumanMessage("target history")] });
    await session.thread.create();
    const heads = vi.spyOn(h.backend.threads, "get");
    const checkpoints = vi.spyOn(h.backend.checkpoints, "get");
    await session.thread.switch(target.id);
    expect(session.thread.getId()).toBe(target.id);
    expect(session.state.get().messages[0]!.content).toEqual([{ type: "text", text: "target history" }]);
    expect(heads).toHaveBeenCalledTimes(2);
    expect(checkpoints).toHaveBeenCalledTimes(1);
  } finally { await h.dispose(); }
});

it("keeps snapshot activity tied to its checkpoint when execution starts during loading", async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  const h = await AgentHarness.create({
    modelScripts: [{ text: "answer", gate }],
    plugins: [{ id: "started", setup(context) { context.hook(model.start, () => { start(); }); } }],
  });
  let running: Promise<unknown> | undefined;
  try {
    const session = await h.controller.createSession();
    const target = await session.thread.create();
    const read = h.backend.checkpoints.get.bind(h.backend.checkpoints);
    let advance = true;
    h.backend.checkpoints.get = async id => {
      const checkpoint = await read(id);
      if (advance) {
        advance = false;
        running = h.collect(target.stream({ input: new HumanMessage("concurrent"), model: h.provider.ref }));
        await started;
      }
      return checkpoint;
    };
    const snapshot = await target.snapshot();
    expect(snapshot.execution).toBeNull();
    expect(snapshot.activeStreamId).toBeNull();
    expect(snapshot.state.messages).toEqual([]);
  } finally { release(); await running; await h.dispose(); }
});

it("hydrates execution records from the loaded checkpoint when execution finishes during loading", async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  const { promise: ended, resolve: end } = Promise.withResolvers<void>();
  const h = await AgentHarness.create({
    modelScripts: [{ text: "answer", gate }, { text: "next answer" }],
    plugins: [{ id: "started", setup(context) { context.hook(model.start, () => { start(); }); } }],
  });
  try {
    const session = await h.controller.createSession();
    await session.thread.create();
    session.subscribe(stream.end, () => { end(); });
    await session.followUp("question");
    await started;
    const read = h.backend.checkpoints.get.bind(h.backend.checkpoints);
    let advance = true;
    h.backend.checkpoints.get = async id => {
      const checkpoint = await read(id);
      if (advance) { advance = false; release(); await ended; }
      return checkpoint;
    };
    const restored = (await h.controller.getSession(session.id))!;
    expect(restored.state.get().status).toBe("running");
    expect(restored.state.get().messages.map(message => message.content)).toEqual([
      [{ type: "text", text: "question" }],
    ]);
    expect(session.state.get().status).toBe("completed");
    const { promise: followed, resolve: finish } = Promise.withResolvers<void>();
    restored.subscribe(stream.end, () => { finish(); });
    await restored.followUp("next");
    await vi.waitFor(() => { expect(h.provider.calls).toHaveLength(2); });
    await followed;
    expect(restored.state.get().status).toBe("completed");
  } finally { release(); await h.dispose(); }
});

it("hydrates Session history without loading model usage and keeps public snapshot usage", async () => {
  const h = await AgentHarness.create({ modelScripts: [{ text: "answer" }] });
  try {
    const session = await h.controller.createSession();
    const first = await session.thread.create();
    await h.collect(first.stream({ input: new HumanMessage("question"), model: h.provider.ref }));
    const lists = vi.spyOn(h.backend.executions, "listRecords");
    await session.thread.create({ messages: [new HumanMessage("other")] });
    await session.thread.switch(first.id);
    const restored = (await h.controller.getSession(session.id))!;
    for (const handle of [session, restored]) {
      expect(handle.state.get().messages.map(message => message.content)).toEqual([
        [{ type: "text", text: "question" }],
        [{ type: "text", text: "answer" }],
      ]);
      expect(handle.state.get().status).toBe("idle");
    }
    expect(lists).not.toHaveBeenCalled();
    expect((await first.snapshot()).usage.metrics.totalTokens.totalAttempts).toBe(1);
    expect(lists).toHaveBeenCalledWith("model_attempts", first.id);
  } finally { await h.dispose(); }
});

it("reads the selected checkpoint once after Session CAS and sees concurrent history changes", async () => {
  const h = await AgentHarness.create();
  try {
    const session = await h.controller.createSession();
    const target = await session.thread.create({ messages: [new HumanMessage("before")] });
    await session.thread.create();
    const write = h.backend.sessions.compareAndSet.bind(h.backend.sessions);
    h.backend.sessions.compareAndSet = async (...args) => {
      await write(...args);
      await new ThreadService(h.backend).mutate(target.id, cp => ({
        ...cp,
        state: { ...cp.state, messages: [MessageCodec.encode(new HumanMessage("during CAS"))] },
      }));
    };
    const checkpoints = vi.spyOn(h.backend.checkpoints, "get");
    await session.thread.switch(target.id);
    // One checkpoint belongs to the concurrent writer; hydration needs only the new one.
    expect(checkpoints).toHaveBeenCalledTimes(2);
    expect(session.state.get().messages[0]!.content).toEqual([{ type: "text", text: "during CAS" }]);
    expect((await h.backend.sessions.get(session.id))!.selectedThreadId).toBe(target.id);
  } finally { await h.dispose(); }
});

it("rechecks Thread existence after beforeSwitch without persisting a deleted selection", async () => {
  const h = await AgentHarness.create();
  try {
    const session = await h.controller.createSession({ scope: { user: "one" } });
    const target = await session.thread.create();
    const selected = await session.thread.create();
    await h.controller.plugins.attach({
      id: "delete-before-switch",
      setup(context) {
        context.hook(sessionHooks.thread.beforeSwitch, async () => {
          await new ThreadService(h.backend).delete(target.id);
        });
      },
    });
    await expect(session.thread.switch(target.id)).rejects.toMatchObject({ code: "ThreadNotFound" });
    expect(session.thread.getId()).toBe(selected.id);
    expect((await h.backend.sessions.get(session.id))!.selectedThreadId).toBe(selected.id);
    expect(session.state.get().messages).toEqual([]);
  } finally { await h.dispose(); }
});

it("blocks queued input when the target becomes active during Session CAS", async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  const h = await AgentHarness.create({
    modelScripts: [{ text: "owner", gate }],
    plugins: [{ id: "started", setup(context) { context.hook(model.start, () => { start(); }); } }],
  });
  let running: Promise<unknown> | undefined;
  try {
    const owner = await h.controller.createSession();
    const target = await owner.thread.create();
    const viewer = await h.controller.createSession();
    const write = h.backend.sessions.compareAndSet.bind(h.backend.sessions);
    h.backend.sessions.compareAndSet = async (...args) => {
      await write(...args);
      running = h.collect(target.stream({ input: new HumanMessage("owner"), model: h.provider.ref }));
      await started;
    };
    await viewer.thread.switch(target.id);
    const errors: string[] = [];
    viewer.subscribe(stream.error, event => { errors.push(event.payload.error.code); });
    await viewer.followUp("queued");
    await new Promise(resolve => setImmediate(resolve));
    expect(errors).toEqual([]);
    expect(viewer.followUp.count()).toBe(1);
    expect(h.provider.calls).toHaveLength(1);
  } finally { release(); await running; await h.dispose(); }
});

it("rejects a Thread purged before its checkpoint can be loaded", async () => {
  const h = await AgentHarness.create();
  try {
    const session = await h.controller.createSession();
    const target = await session.thread.create();
    const read = h.backend.checkpoints.get.bind(h.backend.checkpoints);
    let remove = true;
    h.backend.checkpoints.get = async id => {
      if (remove) {
        remove = false;
        await new ThreadService(h.backend).delete(target.id);
        await h.backend.threads.purge(target.id);
      }
      return read(id);
    };
    await expect(target.snapshot()).rejects.toMatchObject({ code: "ThreadNotFound" });
  } finally { await h.dispose(); }
});

it("rejects follow-up when selection changes during a blocked Thread activity refresh", async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  const { promise: reading, resolve: entered } = Promise.withResolvers<void>();
  const { promise: readGate, resolve: releaseRead } = Promise.withResolvers<void>();
  const h = await AgentHarness.create({
    modelScripts: [{ text: "answer", gate }],
    plugins: [{ id: "started", setup(context) { context.hook(model.start, () => { start(); }); } }],
  });
  try {
    const owner = await h.controller.createSession();
    const target = await owner.thread.create();
    await owner.followUp("question");
    await started;
    const restored = (await h.controller.getSession(owner.id))!;
    const read = h.backend.threads.get.bind(h.backend.threads);
    let pause = true;
    h.backend.threads.get = async (...args) => {
      const head = await read(...args);
      if (pause) { pause = false; entered(); await readGate; }
      return head;
    };
    const sending = restored.followUp("racing");
    const rejected = expect(sending).rejects.toMatchObject({ code: "SessionBusy" });
    await reading;
    const next = await restored.thread.create();
    releaseRead();
    await rejected;
    expect(restored.thread.getId()).toBe(next.id);
    expect(restored.thread.getId()).not.toBe(target.id);
    expect(restored.followUp.isEmpty()).toBe(true);
    expect(h.provider.calls).toHaveLength(1);
  } finally { releaseRead(); release(); await h.dispose(); }
});
