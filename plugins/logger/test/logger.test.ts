import {
  model as modelHooks,
  stream as streamHooks,
  diagnostic as diagnosticHooks,
} from "@tessar/core";
import { expect, it, vi } from "vitest";
import {
  HumanMessage,
  MessageCodec,
  createMemoryBackend,
  type Plugin,
} from "@tessar/core";
import { AgentHarness } from "@tessar/core/testing";
import { LoggerPlugin, type LogEntry } from "@tessar/logger";

it("logs provider errors with execution identity and persists their source", async () => {
  const entries: LogEntry[] = [];
  const error = Object.assign(new Error("Rate limited"), {
    code: "rate_limit_exceeded",
    status: 429,
  });
  const logger = new LoggerPlugin({
    transports: [
      {
        write: (entry) => {
          entries.push(entry);
        },
      },
    ],
  });
  expect(logger).toBeInstanceOf(LoggerPlugin);
  const harness = await AgentHarness.create({
    modelScripts: [{ error }],
    plugins: [logger],
  });
  try {
    const thread = await harness.createThread();
    const stream = harness.admit({
      kind: "input",
      threadId: thread.id,
      input: [MessageCodec.encode(new HumanMessage("hi"))],
      model: harness.provider.ref,
    });
    await harness.collect(stream);
    expect(entries.find((e) => e.type === modelHooks.error)).toMatchObject({
      level: "error",
      threadId: thread.id,
      streamId: stream.id,
      payload: {
        error: {
          source: "provider",
          providerId: "scripted",
          code: "rate_limit_exceeded",
          details: { status: 429 },
        },
      },
    });
    expect((await harness.records(stream.id!)).stream.error).toMatchObject({
      source: "provider",
      code: "rate_limit_exceeded",
    });
  } finally {
    await harness.dispose();
  }
});

it("reports observer and plugin notification failures without recursive logger errors", async () => {
  const entries: LogEntry[] = [];
  const broken: Plugin = {
    id: "broken",
    setup(tessar) {
      tessar.hook(modelHooks.start, () => {
        throw Error("plugin failed");
      });
    },
  };
  const harness = await AgentHarness.create({
    modelScripts: [{ text: "ok" }],
    plugins: [
      new LoggerPlugin({
        transports: [
          {
            write: (entry) => {
              entries.push(entry);
            },
          },
        ],
      }),
      broken,
    ],
  });
  try {
    const session = await harness.controller.createSession({
      model: harness.provider.ref,
    });
    const thread = await session.thread.create();
    const done = new Promise<void>((resolve) =>
      session.subscribe(streamHooks.end, () => resolve()),
    );
    session.subscribe(modelHooks.start, () => {
      throw Error("observer failed");
    });
    await session.followUp(new HumanMessage("hi"));
    await done;
    expect(entries.filter((e) => e.type === diagnosticHooks)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: thread.id,
          payload: {
            error: expect.objectContaining({
              source: "plugin",
              pluginId: "broken",
            }),
          },
        }),
        expect.objectContaining({
          threadId: thread.id,
          payload: {
            error: expect.objectContaining({ source: "application" }),
          },
        }),
      ]),
    );
  } finally {
    await harness.dispose();
  }
});

it.each([false, true])(
  "isolates logger writer failure (async=%s)",
  async (asynchronous) => {
    const write = vi.fn(() => {
      if (asynchronous) return Promise.reject(Error("sink unavailable"));
      throw Error("sink unavailable");
    });
    const silent = await AgentHarness.create({
      modelScripts: [{ text: "ok" }],
      plugins: [new LoggerPlugin({ transports: [{ write }] })],
    });
    try {
      const result = await silent.agent.generate(new HumanMessage("hi"), {
        model: silent.provider.ref,
      });
      expect(result.status).toBe("completed");
      expect(write.mock.calls.length).toBeLessThan(100);
    } finally {
      await silent.dispose();
    }
  },
);

it("logs storage failures and rethrows the original exception", async () => {
  const entries: LogEntry[] = [];
  const backend = createMemoryBackend();
  const harness = await AgentHarness.create({
    backend,
    plugins: [
      new LoggerPlugin({
        transports: [
          {
            write: (entry) => {
              entries.push(entry);
            },
          },
        ],
      }),
    ],
  });
  const original = backend.commits.stage;
  try {
    const thread = await harness.createThread();
    const error = Error("disk failed");
    backend.commits.stage = async () => {
      throw error;
    };
    await expect(
      harness.collect(
        harness.admit({
          kind: "input",
          threadId: thread.id,
          input: [MessageCodec.encode(new HumanMessage("hi"))],
          model: harness.provider.ref,
        }),
      ),
    ).rejects.toBe(error);
    expect(entries.find((e) => e.type === diagnosticHooks)).toMatchObject({
      payload: {
        error: {
          source: "storage",
          backendId: "memory",
          message: "disk failed",
        },
      },
    });
  } finally {
    backend.commits.stage = original;
    await harness.dispose();
  }
});

it("logs decision hook failures without exposing mutable services to diagnostics", async () => {
  const contexts: Record<string, unknown>[] = [];
  const entries: LogEntry[] = [];
  const harness = await AgentHarness.create({
    plugins: [
      new LoggerPlugin({
        transports: [
          {
            write: (entry) => {
              entries.push(entry);
            },
          },
        ],
      }),
      {
        id: "policy",
        setup(tessar) {
          tessar.hook(streamHooks.before, () => {
            throw Error("policy failed");
          });
          tessar.hook(diagnosticHooks, (_event, context) => {
            contexts.push(context);
          });
        },
      },
    ],
  });
  try {
    const result = await harness.agent.generate(new HumanMessage("hi"), {
      model: harness.provider.ref,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({
      source: "plugin",
      pluginId: "policy",
    });
    expect(entries.find((e) => e.type === diagnosticHooks)).toMatchObject({
      threadId: result.threadId,
      streamId: result.streamId,
    });
    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts) {
      expect(context).not.toHaveProperty("state");
      expect(context).not.toHaveProperty("effects");
      expect(context).not.toHaveProperty("models");
      expect(context).not.toHaveProperty("suspend");
    }
  } finally {
    await harness.dispose();
  }
});

it("writes JSON to stderr by default and stops receiving events after detach", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => { });
  const harness = await AgentHarness.create({
    modelScripts: [{ text: "one" }, { text: "two" }],
    plugins: [new LoggerPlugin()],
  });
  try {
    await harness.agent.generate(new HumanMessage("hi"), {
      model: harness.provider.ref,
    });
    expect(stderr.mock.calls.map(([line]) => JSON.parse(line))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: streamHooks.end,
          level: "info",
          agentId: "test-agent",
        }),
      ]),
    );
    await harness.controller.plugins.detach("logger");
    const count = stderr.mock.calls.length;
    await harness.agent.generate(new HumanMessage("hi again"), {
      model: harness.provider.ref,
    });
    expect(stderr).toHaveBeenCalledTimes(count);
  } finally {
    await harness.dispose();
    stderr.mockRestore();
  }
});
