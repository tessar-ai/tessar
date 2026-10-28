import { expect, it, vi } from "vitest";
import {
  Agent,
  Controller,
  TessarError,
  checkpoint,
  input,
  message,
  thread,
  stream as streamEvents,
  type Plugin,
} from "../../src/index.js";
import { ScriptedProvider } from "../../src/testing/scripted-provider.js";
import type { Stream } from "../../src/agent.js";
import { createMemoryBackend } from "../../src/state/memory-backend.js";

async function collect(stream: Stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([thread.prepare, thread.started, input.prepare])(
  "accepts input from %s without waiting for admission",
  async (hook) => {
    const release = gate();
    let receipt: "pending" | "accepted" | "rejected" = "pending";
    let sent = false;
    const provider = new ScriptedProvider([{ text: "done" }]);
    const agent = new Agent({ id: "signal-admit-" + hook, model: provider });
    const controller = new Controller({
      id: "signal-admit-" + hook,
      agent,
      plugins: [
        {
          id: "input",
          setup(tessar) {
            tessar.hook(hook, async (event) => {
              if (!sent) {
                sent = true;
                const received = agent
                  .sendSignal({
                    streamId: "target",
                    content: "during admission",
                  })
                  .then(
                    () => {
                      receipt = "accepted";
                    },
                    () => {
                      receipt = "rejected";
                    },
                  );
                await Promise.race([received, release.promise]);
              }
              if (hook === thread.prepare || hook === input.prepare)
                return event.payload as never;
            });
          },
        },
      ],
    });
    await controller.initialize();
    const stream = agent.stream("start", { id: "target" });
    const done = collect(stream);
    try {
      await vi.waitFor(() => expect(receipt).toBe("accepted"), {
        timeout: 500,
      });
      await done;
      expect(JSON.stringify(provider.calls[0]!.messages)).toContain(
        "during admission",
      );
    } finally {
      release.resolve();
      await done;
      await controller.dispose();
    }
  },
);

it("accepts cross-stream signals from admission hooks without circular waits", async () => {
  const entered = gate(),
    release = gate();
  let count = 0,
    accepted = 0;
  const provider = new ScriptedProvider([{ text: "one" }, { text: "two" }]);
  const agent = new Agent({ id: "signal-cross", model: provider });
  const controller = new Controller({
    id: "signal-cross",
    agent,
    plugins: [
      {
        id: "cross",
        setup(tessar) {
          tessar.hook(thread.prepare, async (event) => {
            const index = count++;
            if (count === 2) entered.resolve();
            await entered.promise;
            const received = agent
              .sendSignal({
                streamId: index === 0 ? "second" : "first",
                content: "cross input",
              })
              .then(() => {
                accepted++;
              });
            await Promise.race([received, release.promise]);
            return event.payload;
          });
        },
      },
    ],
  });
  await controller.initialize();
  const done = Promise.all([
    collect(agent.stream("a", { id: "first" })),
    collect(agent.stream("b", { id: "second" })),
  ]);
  try {
    await vi.waitFor(() => expect(accepted).toBe(2), { timeout: 500 });
    await done;
    expect(
      provider.calls.every((call) =>
        JSON.stringify(call.messages).includes("cross input"),
      ),
    ).toBe(true);
  } finally {
    release.resolve();
    await done;
    await controller.dispose();
  }
});

it("accepts immediate durable signals, acknowledges during I/O and continues the same stream", async () => {
  const barrier = gate();
  const provider = new ScriptedProvider([
    { text: "first", gate: barrier.promise },
    { text: "second" },
  ]);
  const agent = new Agent({ id: "signal-immediate", model: provider });
  const controller = new Controller({ id: "signal-immediate", agent });
  await controller.initialize();
  try {
    const stream = agent.stream("original", { id: "target" });
    const result = collect(stream);
    await agent.sendSignal({ streamId: stream.id!, content: "early" });
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await agent.sendSignal({
      streamId: stream.id!,
      content: "incoming",
      metadata: { source: "app" },
    });
    await vi.waitFor(async () =>
      expect(
        (await controller.queries.snapshot(stream.threadId)).execution!
          .pendingSignals,
      ).toHaveLength(1),
    );
    const cp = await controller.queries.snapshot(stream.threadId);
    expect(cp.state.messages[0]!.content).toEqual([
      { type: "text", text: "original" },
    ]);
    barrier.resolve();
    const events = await result;
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.messages.map((m) => m.content)).toEqual([
      [{ type: "text", text: "original" }],
      [{ type: "text", text: "early" }],
      [{ type: "text", text: "first" }],
      [{ type: "text", text: "incoming" }],
    ]);
    expect(events.every((event) => event.streamId === "target")).toBe(true);
    const final = await controller.queries.snapshot(stream.threadId);
    expect(final.execution).toBeNull();
    expect(
      final.state.messages.filter((m) => m.metadata?.source === "app"),
    ).toHaveLength(1);
    await expect(
      agent.sendSignal({ streamId: stream.id!, content: "late" }),
    ).rejects.toThrow();
  } finally {
    barrier.resolve();
    await controller.dispose();
  }
});

it("keeps transient input in context but never in checkpoints", async () => {
  const barrier = gate();
  const provider = new ScriptedProvider([
    { text: "one", gate: barrier.promise },
    { text: "two" },
  ]);
  const agent = new Agent({ id: "signal-transient", model: provider });
  const controller = new Controller({ id: "signal-transient", agent });
  await controller.initialize();
  try {
    const stream = agent.stream("start");
    const result = collect(stream);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await agent.sendSignal({
      streamId: stream.id!,
      content: "PRIVATE_SIGNAL",
      persist: false,
    });
    barrier.resolve();
    await result;
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain(
      "PRIVATE_SIGNAL",
    );
    const checkpoints = await controller.backend.checkpoints.list(
      stream.threadId,
    );
    expect(JSON.stringify(checkpoints)).not.toContain("PRIVATE_SIGNAL");
  } finally {
    barrier.resolve();
    await controller.dispose();
  }
});

it("delivers concurrent signals without overwriting and rejects unknown targets", async () => {
  const barrier = gate();
  const provider = new ScriptedProvider([
    { gate: barrier.promise, text: "one" },
    { text: "done" },
  ]);
  const agent = new Agent({ id: "signal-parallel", model: provider });
  try {
    await expect(
      agent.sendSignal({ streamId: "missing", content: "x" }),
    ).rejects.toThrow();
    const stream = agent.stream("start");
    const result = collect(stream);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await Promise.all(
      ["a", "b"].map((content) =>
        agent.sendSignal({ streamId: stream.id!, content }),
      ),
    );
    barrier.resolve();
    await result;
    expect(provider.calls[1]!.messages.slice(-2).map((m) => m.content)).toEqual(
      [[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]],
    );
  } finally {
    barrier.resolve();
    await agent.shutdown();
  }
});

it("preserves acceptance order when durable and transient messages are interleaved", async () => {
  const barrier = gate();
  const provider = new ScriptedProvider([
    { gate: barrier.promise, text: "first" },
    { text: "done" },
  ]);
  const agent = new Agent({ id: "signal-order", model: provider });
  try {
    const stream = agent.stream("start"),
      result = collect(stream);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await agent.sendSignal({
      streamId: stream.id!,
      content: "a",
      persist: false,
    });
    await agent.sendSignal({ streamId: stream.id!, content: "b" });
    await agent.sendSignal({
      streamId: stream.id!,
      content: "c",
      persist: false,
    });
    await agent.sendSignal({ streamId: stream.id!, content: "d" });
    barrier.resolve();
    await result;
    expect(
      provider.calls[1]!.messages.slice(-4).map((message) => message.content),
    ).toEqual(["a", "b", "c", "d"].map((text) => [{ type: "text", text }]));
  } finally {
    barrier.resolve();
    await agent.shutdown();
  }
});

it("reports a failed signal write through execution events after acknowledging receipt", async () => {
  const barrier = gate();
  const provider = new ScriptedProvider([
    { gate: barrier.promise, text: "first" },
    { text: "done" },
  ]);
  const agent = new Agent({ id: "signal-write-fail", model: provider });
  const backend = createMemoryBackend();
  const controller = new Controller({
    id: "signal-write-fail",
    agent,
    plugins: [{ id: "storage", setup(tessar) { tessar.storage.register(backend); } }],
  });
  await controller.initialize();
  try {
    const stream = agent.stream("start"),
      result = collect(stream);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const publish = vi.spyOn(backend.commits, "publish");
    publish.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(
      agent.sendSignal({ streamId: stream.id!, content: "failed-input" }),
    ).resolves.toBeUndefined();
    barrier.resolve();
    const events = await result;
    expect(
      events.find((event) => event.type === streamEvents.error)!.payload.error
        .message,
    ).toBe("storage unavailable");
    expect(JSON.stringify(provider.calls)).not.toContain("failed-input");
    expect(provider.calls).toHaveLength(1);
  } finally {
    barrier.resolve();
    await controller.dispose();
  }
});

it("allows an admitted checkpoint hook to await signal acceptance without deadlock", async () => {
  const provider = new ScriptedProvider([{ text: "done" }]);
  const agent = new Agent({ id: "signal-hook", model: provider });
  let sent = false,
    armed = false;
  const plugin: Plugin = {
    id: "checkpoint-signal",
    setup(tessar) {
      tessar.hook(checkpoint.committed, async (_payload, context) => {
        if (armed && !sent && typeof context.streamId === "string") {
          sent = true;
          await agent.sendSignal({
            streamId: context.streamId,
            content: "from-hook",
          });
        }
      });
      tessar.hook(input.received, () => {
        armed = true;
      });
    },
  };
  const controller = new Controller({
    id: "signal-hook",
    agent,
    plugins: [plugin],
  });
  await controller.initialize();
  try {
    await agent.generate("start");
    expect(JSON.stringify(provider.calls)).toContain("from-hook");
  } finally {
    await controller.dispose();
  }
});

it("acknowledges messages without waiting for serialized commit callbacks", async () => {
  const modelGate = gate(),
    callbackGate = gate(),
    entered = gate();
  const provider = new ScriptedProvider([
    { text: "first", gate: modelGate.promise },
    { text: "done" },
  ]);
  const agent = new Agent({ id: "signal-ack", model: provider });
  let armed = false,
    paused = false;
  const revisions: number[] = [];
  const controller = new Controller({
    id: "signal-ack",
    agent,
    plugins: [
      {
        id: "pause",
        setup(tessar) {
          tessar.hook(checkpoint.committed, async (event) => {
            if (!armed) return;
            revisions.push(event.payload.revision);
            if (!paused) {
              paused = true;
              entered.resolve();
              await callbackGate.promise;
            }
          });
        },
      },
    ],
  });
  await controller.initialize();
  const stream = agent.stream("start"),
    done = collect(stream);
  try {
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    armed = true;
    await agent.sendSignal({ streamId: stream.id!, content: "one" });
    await entered.promise;
    await agent.sendSignal({ streamId: stream.id!, content: "two" });
    expect(revisions).toHaveLength(1);
    expect(
      (await controller.queries.snapshot(stream.threadId)).execution!
        .pendingSignals,
    ).toHaveLength(1);
    callbackGate.resolve();
    modelGate.resolve();
    await done;
    expect(
      provider.calls[1]!.messages.slice(-2).map((message) => message.content),
    ).toEqual([
      [{ type: "text", text: "one" }],
      [{ type: "text", text: "two" }],
    ]);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
  } finally {
    callbackGate.resolve();
    modelGate.resolve();
    await done;
    await controller.dispose();
  }
});

it("keeps a published signal pending when a postcommit hook fails", async () => {
  const modelGate = gate();
  const provider = new ScriptedProvider([
    { text: "first", gate: modelGate.promise },
  ]);
  const agent = new Agent({ id: "signal-postcommit", model: provider });
  let armed = false;
  const controller = new Controller({
    id: "signal-postcommit",
    agent,
    plugins: [
      {
        id: "fail",
        setup(tessar) {
          tessar.hook(checkpoint.committed, () => {
            if (armed) {
              armed = false;
              throw new TessarError(
                "StorageUnavailable",
                "notification failed",
              );
            }
          });
        },
      },
    ],
  });
  await controller.initialize();
  const stream = agent.stream("start"),
    done = collect(stream);
  try {
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    armed = true;
    await expect(
      agent.sendSignal({ streamId: stream.id!, content: "published input" }),
    ).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(
        controller.diagnostics.some(
          (entry) => entry.message === "notification failed",
        ),
      ).toBe(true),
    );
    modelGate.resolve();
    expect(
      (await done).find((event) => event.type === streamEvents.error)!.payload
        .error.message,
    ).toBe("notification failed");
    const saved = await controller.queries.snapshot(stream.threadId);
    expect(saved.execution!.pendingSignals![0]!.content).toEqual([
      { type: "text", text: "published input" },
    ]);
    expect(provider.calls).toHaveLength(1);
  } finally {
    modelGate.resolve();
    await done;
    await controller.dispose();
  }
});

it("reports failed admission after accepting a buffered signal", async () => {
  const agent = new Agent({
    id: "signal-admission-fail",
    model: new ScriptedProvider([]),
  });
  const controller = new Controller({
    id: "signal-admission-fail",
    agent,
    plugins: [
      {
        id: "reject",
        setup(tessar) {
          tessar.hook(input.prepare, () => {
            throw Error("reject admission");
          });
        },
      },
    ],
  });
  await controller.initialize();
  try {
    const stream = agent.stream("start");
    const done = collect(stream);
    await expect(
      agent.sendSignal({ streamId: stream.id!, content: "not processed" }),
    ).resolves.toBeUndefined();
    expect(
      (await done).find((event) => event.type === streamEvents.error)!.payload
        .error.message,
    ).toBe("reject admission");
  } finally {
    await controller.dispose();
  }
});

it("rejects signals at the closed completion boundary instead of acknowledging lost input", async () => {
  const agent = new Agent({
    id: "signal-terminal",
    model: new ScriptedProvider([{ text: "done" }]),
  });
  let rejection: unknown;
  const controller = new Controller({
    id: "signal-terminal",
    agent,
    plugins: [
      {
        id: "late-signal",
        setup(tessar) {
          tessar.hook(streamEvents.end, async (_event, context) => {
            try {
              await agent.sendSignal({
                streamId: String(context.streamId),
                content: "late",
              });
            } catch (error) {
              rejection = error;
            }
          });
        },
      },
    ],
  });
  await controller.initialize();
  try {
    expect((await agent.generate("start")).status).toBe("completed");
    expect(rejection).toMatchObject({ code: "AlreadyTerminal" });
  } finally {
    await controller.dispose();
  }
});

it("preserves concurrently committed plugin state and arrivals during message preparation", async () => {
  const barrier = gate();
  const provider = new ScriptedProvider([
    { gate: barrier.promise, text: "first" },
    { text: "second" },
    { text: "done" },
  ]);
  const agent = new Agent({ id: "signal-plugin-state", model: provider });
  let injected = false;
  const controller = new Controller({
    id: "signal-plugin-state",
    agent,
    plugins: [
      {
        id: "state",
        setup(tessar) {
          const state = tessar.state.define({
            namespace: "counter",
            schemaVersion: 1,
            initial: { value: 0 },
          });
          tessar.hook(message.prepare, async (event, context) => {
            if (
              !injected &&
              event.payload.content.some(
                (part) => part.type === "text" && part.text === "first-signal",
              )
            ) {
              injected = true;
              context.state.update(state, { value: 1 });
              await Promise.all([
                context.state.commit(),
                agent.sendSignal({
                  streamId: context.streamId,
                  content: "during-preparation",
                }),
              ]);
            }
            return event.payload;
          });
        },
      },
    ],
  });
  await controller.initialize();
  try {
    const stream = agent.stream("start"),
      done = collect(stream);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await agent.sendSignal({ streamId: stream.id!, content: "first-signal" });
    barrier.resolve();
    await done;
    expect(provider.calls).toHaveLength(3);
    const cp = await controller.queries.snapshot(stream.threadId);
    expect(
      cp.state.pluginStates.find((entry) => entry.namespace === "counter")!
        .data,
    ).toEqual({ value: 1 });
    expect(
      cp.state.messages.filter((entry) =>
        entry.content.some(
          (part) => part.type === "text" && part.text === "during-preparation",
        ),
      ),
    ).toHaveLength(1);
  } finally {
    barrier.resolve();
    await controller.dispose();
  }
});
