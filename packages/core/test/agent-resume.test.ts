import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  Controller,
  AssistantMessage,
  MessageCodec,
  createTool,
  errorFromInfo,
  input,
  stream as events,
  type Stream,
} from "../src/index.js";
import { ScriptedProvider } from "../src/testing/scripted-provider.js";
import { standaloneFor } from "../src/engine/continuation.js";

it("rejects abort before admission without blocking input.prepare", async () => {
  const agent = new Agent({ id: randomUUID(), model: new ScriptedProvider([{ text: "done" }]) });
  let early: unknown;
  const controller = new Controller({ id: randomUUID(), agent, plugins: [{
    id: "early-abort",
    setup(plugin) {
      plugin.hook(input.prepare, async event => {
        early = await Promise.race([agent.abort(event.streamId!).catch(error => error), delay(250, "pending")]);
        return event.payload;
      });
    },
  }] });
  try {
    await controller.initialize();
    const result = await agent.generate("work");
    expect(early).toMatchObject({ code: "InvalidTransition" });
    expect(result.status).toBe("completed");
  } finally { await controller.dispose(); }
});

async function collect(stream: Stream) {
  const result = [];
  for await (const event of stream) {
    if (event.type === events.error) throw errorFromInfo(event.payload.error);
    result.push(event);
  }
  return result;
}
function fixture() {
  let calls = 0;
  const ask = createTool({
    name: "ask",
    description: "Ask",
    schema: z.object({}),
    resumeSchema: z.string(),
    execute: (_input, context) => {
      calls++;
      return context.suspend({ question: "Choose" });
    },
  });
  const model = new ScriptedProvider([
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
  const agent = new Agent({ id: randomUUID(), model, tools: { ask } });
  return { agent, model, calls: () => calls };
}

it("resumes standalone after an invalid answer without replaying execute", async () => {
  const { agent, model, calls } = fixture();
  try {
    const first = await agent.generate("ask");
    expect(first.status).toBe("suspended");
    const options = {
      threadId: first.threadId,
      interruptId: first.interrupt!.id,
    };
    await expect(
      collect(agent.resume({ ...options, value: false })),
    ).rejects.toMatchObject({ code: "InvalidResumeResponse" });
    const next = agent.resume({ ...options, value: "chosen" });
    expect(
      (await collect(next)).find((e) => e.type === events.end)!.payload.status,
    ).toBe("completed");
    expect(next.id).toBe(first.streamId);
    expect(calls()).toBe(1);
    expect(
      model.calls[1]!.messages.find((m) => m.role === "tool")!.content,
    ).toEqual([{ type: "text", text: "chosen" }]);
  } finally {
    await agent.shutdown();
  }
});

it("accepts resume from the suspended event while the old attachment is closing", async () => {
  const { agent } = fixture();
  try {
    const first = agent.stream("ask");
    let continuation!: Promise<Awaited<ReturnType<typeof collect>>>;
    for await (const event of first)
      if (event.type === events.suspended) {
        continuation = collect(
          agent.resume({
            threadId: first.threadId,
            interruptId: event.payload.interrupt.id,
            value: "answer",
          }),
        );
      }
    expect(
      (await continuation).find((e) => e.type === events.end)!.payload.status,
    ).toBe("completed");
  } finally {
    await agent.shutdown();
  }
});

it("cancels a waiting standalone execution through its suspended handle", async () => {
  const { agent } = fixture();
  try {
    const first = agent.stream("ask");
    const pending = (await collect(first)).find(
      (e) => e.type === events.suspended,
    )!.payload.interrupt;
    first.abort("no answer");
    await expect(
      collect(
        agent.resume({
          threadId: first.threadId,
          interruptId: pending.id,
          value: "late",
        }),
      ),
    ).rejects.toThrow();
  } finally {
    await agent.shutdown();
  }
});

it("preserves the per-call model and options across standalone resume", async () => {
  const { agent, model } = fixture();
  try {
    const first = await agent.generate("ask", {
      model: "alternate",
      modelOptions: { temperature: 0.25 },
    });
    await collect(
      agent.resume({
        threadId: first.threadId,
        interruptId: first.interrupt!.id,
        value: "answer",
      }),
    );
    expect(model.calls.map((r) => r.model.modelId)).toEqual([
      "alternate",
      "alternate",
    ]);
    expect(model.calls.map((r) => r.options)).toEqual([
      { temperature: 0.25 },
      { temperature: 0.25 },
    ]);
  } finally {
    await agent.shutdown();
  }
});

it("cancels waiting work when its original external signal is aborted", async () => {
  const { agent } = fixture();
  try {
    const control = new AbortController();
    const first = agent.stream("ask", { signal: control.signal });
    const pending = (await collect(first)).find(
      (e) => e.type === events.suspended,
    )!.payload.interrupt;
    control.abort("leave page");
    await expect(
      Promise.resolve().then(() =>
        collect(
          agent.resume({
            threadId: first.threadId,
            interruptId: pending.id,
            value: "late",
          }),
        ),
      ),
    ).rejects.toThrow();
  } finally {
    await agent.shutdown();
  }
});

it("consumes competing standalone responses once and ignores stale abort handles", async () => {
  const { agent, calls } = fixture();
  try {
    const first = agent.stream("ask");
    const pending = (await collect(first)).find(
      (e) => e.type === events.suspended,
    )!.payload.interrupt;
    const options = {
      threadId: first.threadId,
      interruptId: pending.id,
      value: "answer",
    };
    const one = (async () => {
      for await (const event of agent.resume(options)) {
        if (event.type === events.resumed) first.abort("stale handle");
        if (event.type === events.error)
          throw errorFromInfo(event.payload.error);
      }
    })();
    const duplicate = collect(agent.resume(options));
    const results = await Promise.allSettled([one, duplicate]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(calls()).toBe(1);
  } finally {
    await agent.shutdown();
  }
});

it("isolates simultaneous standalone questions and releases retained runtimes on completion and shutdown", async () => {
  const ask = createTool({
    name: "ask",
    description: "Ask",
    schema: z.object({}),
    execute: (_input, context) => context.suspend("Choose"),
  });
  const question = () => ({
    response: {
      message: MessageCodec.encode(
        new AssistantMessage([
          {
            type: "tool-call",
            name: "ask",
            toolCallId: randomUUID(),
            arguments: {},
          },
        ]),
      ),
    },
  });
  const model = new ScriptedProvider([
    question(),
    question(),
    { text: "done" },
  ]);
  const agent = new Agent({ id: randomUUID(), model, tools: { ask } });
  const [one, two] = await Promise.all([
    agent.generate("one"),
    agent.generate("two"),
  ]);
  expect(standaloneFor(agent, one.threadId)).toBeDefined();
  expect(standaloneFor(agent, two.threadId)).toBeDefined();
  await collect(
    agent.resume({
      threadId: one.threadId,
      interruptId: one.interrupt!.id,
      value: "first",
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(standaloneFor(agent, one.threadId)).toBeUndefined();
  expect(standaloneFor(agent, two.threadId)).toBeDefined();
  await agent.shutdown();
  expect(standaloneFor(agent, two.threadId)).toBeUndefined();
});

it("settles standalone retention when admission throws synchronously", async () => {
  const { agent } = fixture();
  expect(() =>
    agent.stream("invalid", { limits: { maxToolCalls: 0 } }),
  ).toThrow();
  let timer: ReturnType<typeof setTimeout>;
  try {
    expect(
      await Promise.race([
        agent.shutdown().then(() => "closed"),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("pending"), 250);
        }),
      ]),
    ).toBe("closed");
  } finally {
    clearTimeout(timer!);
  }
});

it.each(["handle", "signal"])(
  "keeps the waiting %s cancellable after an invalid response",
  async (method) => {
    const { agent } = fixture();
    try {
      const control = new AbortController();
      const first = agent.stream("ask", { signal: control.signal });
      const question = (await collect(first)).find(
        (e) => e.type === events.suspended,
      )!.payload.interrupt;
      const options = { threadId: first.threadId, interruptId: question.id };
      await expect(
        collect(agent.resume({ ...options, value: false })),
      ).rejects.toMatchObject({ code: "InvalidResumeResponse" });
      if (method === "handle") first.abort("leave");
      else control.abort("leave");
      await expect(
        Promise.resolve().then(() =>
          collect(agent.resume({ ...options, value: "late" })),
        ),
      ).rejects.toThrow();
    } finally {
      await agent.shutdown();
    }
  },
);

it("releases a waiting standalone runtime after direct cancellation", async () => {
  const { agent } = fixture();
  try {
    const result = await agent.generate("ask");
    await agent.cancel(result.threadId, result.streamId);
    expect(standaloneFor(agent, result.threadId)).toBeUndefined();
  } finally {
    await agent.shutdown();
  }
});
