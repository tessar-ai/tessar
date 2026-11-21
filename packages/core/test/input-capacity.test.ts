import { expect, it, vi } from "vitest";
import { stream, createMemoryBackend } from "../src/index.js";
import { fixture } from "./test-fixture.js";

it.each(["followUp", "signal", "scoped signal"] as const)("bounds %s admissions while storage is pending and refunds failed reads", async kind => {
  const backend = createMemoryBackend();
  const gate = Promise.withResolvers<void>();
  const model = Promise.withResolvers<void>();
  const { controller, agent, provider } = await fixture([{ text: "blocked", gate: model.promise }],
    [{ id: "storage", setup(p) { p.storage.register(backend); } }]);
  let settled: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    const session = await controller.createSession(); const thread = await session.thread.create();
    await session.followUp("start");
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const read = kind === "scoped signal" ? vi.spyOn(backend.threads, "get") : vi.spyOn(backend.sessions, "get");
    let reads = 0, rejected = 0;
    read.mockImplementation(async () => { reads++; await gate.promise; throw Error("storage unavailable"); });
    const send = () => kind === "followUp" ? session.followUp("pending") : agent.sendSignal({ threadId: thread.id, content: "pending", scope: kind === "scoped signal" ? {} : undefined });
    settled = Promise.allSettled(Array.from({ length: 101 }, () => send().catch(error => { rejected++; throw error; })));
    await vi.waitFor(() => expect(rejected).toBe(1));
    expect(reads).toBe(100);
    expect(session.isIdle()).toBe(false);
    gate.resolve();
    expect((await settled).filter(result => result.status === "rejected")).toHaveLength(101);
    read.mockRestore();
    if (kind === "followUp") await expect(send()).resolves.toHaveProperty("threadId");
    else await expect(send()).resolves.toBeUndefined();
  } finally { gate.resolve(); model.resolve(); await settled; await controller.dispose(); }
});

it.each(["followUp", "signal"] as const)("is not idle while %s admission is still reading storage", async kind => {
  const backend = createMemoryBackend();
  const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  const { controller, agent } = await fixture([{ text: "done" }], [{ id: "storage", setup(p) { p.storage.register(backend); } }]);
  let admission: Promise<unknown> | undefined;
  try {
    const session = await controller.createSession(); const thread = await session.thread.create();
    const read = backend.sessions.get.bind(backend.sessions);
    backend.sessions.get = async (...args) => { const row = await read(...args); entered.resolve(); await gate.promise; return row; };
    admission = kind === "followUp" ? session.followUp("pending") : agent.sendSignal({ threadId: thread.id, content: "pending" });
    await entered.promise;
    expect(session.isIdle()).toBe(false);
    gate.resolve(); await admission;
  } finally { gate.resolve(); await admission; await controller.dispose(); }
});

it("bounds concurrent queued Session input and refunds capacity after abort", async () => {
  const gate = Promise.withResolvers<void>();
  const { controller, provider } = await fixture([{ text: "blocked", gate: gate.promise }, { text: "next" }]);
  try {
    const session = await controller.createSession();
    await session.thread.create();
    await session.followUp("first");
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const admitted = await Promise.allSettled(Array.from({ length: 101 }, () => session.followUp("queued")));
    expect(admitted.filter(result => result.status === "fulfilled")).toHaveLength(100);
    expect(admitted.filter(result => result.status === "rejected")).toMatchObject([{ reason: { code: "InputQueueFull" } }]);
    expect(session.followUp.count()).toBe(100);
    await session.abort();
    expect(session.followUp.count()).toBe(0);
    const ended = new Promise<void>(resolve => { const off = session.subscribe(stream.end, () => { off(); resolve(); }); });
    await session.followUp("after abort"); await ended;
    expect(session.state.get().status).toBe("completed");
  } finally { gate.resolve(); await controller.dispose(); }
});

it("rejects oversized UTF-8 input before cloning it and keeps the Session usable", async () => {
  const { controller } = await fixture([{ text: "ok" }]);
  try {
    const session = await controller.createSession();
    await session.thread.create();
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      await expect(session.followUp("\u20ac".repeat(2 * 1024 * 1024))).rejects.toMatchObject({ code: "InputQueueFull" });
      expect(clone).not.toHaveBeenCalled();
      expect(session.followUp.isEmpty()).toBe(true);
    } finally { clone.mockRestore(); }
    await expect(session.followUp("valid")).resolves.toHaveProperty("threadId");
  } finally { await controller.dispose(); }
});

it.each([false, true])("bounds pending signals without poisoning accepted execution (persist: %s)", async persist => {
  const gate = Promise.withResolvers<void>();
  const { controller, agent, provider } = await fixture([{ text: "first", gate: gate.promise }, { text: "done" }]);
  const running = agent.stream("start");
  const done = (async () => { const events = []; for await (const event of running) events.push(event); return events; })();
  try {
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    for (let index = 0; index < 100; index++) await agent.sendSignal({ streamId: running.id!, content: "signal", persist });
    await expect(agent.sendSignal({ streamId: running.id!, content: "overflow", persist })).rejects.toMatchObject({ code: "InputQueueFull" });
    gate.resolve();
    const events = await done;
    expect(events.filter(event => event.type === stream.error)).toEqual([]);
    expect(events.findLast(event => event.type === stream.end)?.payload.status).toBe("completed");
  } finally { running.abort(); gate.resolve(); await done; await controller.dispose(); }
});
