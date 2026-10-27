import {
  getThread,
  createThread,
  renameThread,
  deleteThread,
  forkThread,
} from "../../src/state/thread-operations.js";
import { expect, it } from "vitest";
import * as hooks from "../../src/index.js";
import { type Plugin, type AnyEvent } from "../../src/index.js";
import { fixture } from "../test-fixture.js";

it("exports prefix-free event groups with camelCase keys for hyphenated strings", () => {
  expect(hooks.tool.before).toBe("tool.before");
  expect(hooks.session.created).toBe("session.created");
  expect(hooks.thread.beforeDelete).toBe("thread.before-delete");
  expect(hooks.session.model.beforeChange).toBe("session.model.before-change");
  expect(hooks.session.threadSwitched).toBe("session.thread-switched");
  const check = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      expect(
        value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      ).toBe(path);
      return;
    }
    for (const [key, child] of Object.entries(value as object)) {
      expect(key).toMatch(/^[a-z][a-zA-Z]*$/);
      check(child, `${path}.${key}`);
    }
  };
  for (const group of [
    "thread",
    "session",
    "input",
    "stream",
    "turn",
    "context",
    "provider",
    "model",
    "message",
    "tool",
    "checkpoint",
  ] as const)
    check(hooks[group], group);
  expect(
    Object.keys(hooks.model).every((key) => key[0] === key[0]!.toLowerCase()),
  ).toBe(true);
  expect("AgentEvents" in hooks).toBe(false);
  expect("SessionEvents" in hooks).toBe(false);
});

it.each(["fork", "rename", "delete"] as const)(
  "authorizes thread %s once through both Controller and Session and reports committed success",
  async (operation) => {
    const before = {
      fork: "thread.before-fork",
      rename: "thread.before-rename",
      delete: "thread.before-delete",
    }[operation] as AnyEvent;
    const after = {
      fork: "thread.forked",
      rename: "thread.renamed",
      delete: "thread.deleted",
    }[operation] as AnyEvent;
    let deny = true;
    const order: string[] = [];
    const policy: Plugin = {
      id: "policy",
      setup(tessar) {
        tessar.hook(before as any, async (event: any, context: any) => {
          order.push("before");
          expect(context.thread.id).toBe(event.payload.threadId);
          expect(context.thread.scope()).toEqual({ user: "a" });
          await context.thread.getHistory();
          return deny
            ? { decision: "deny", reason: "policy denied" }
            : { decision: "allow" };
        });
        tessar.hook(after as any, async (event: any) => {
          order.push("after");
          if (operation === "rename")
            expect(
              (await getThread(controller, event.payload.threadId))!.id,
            ).toBe(event.payload.threadId);
          if (operation === "delete")
            expect(
              await getThread(controller, event.payload.threadId),
            ).toBeNull();
          if (operation === "fork")
            expect(
              await getThread(controller, event.payload.forkedThreadId),
            ).not.toBeNull();
        });
      },
    };
    const { controller } = await fixture([], [policy]);
    try {
      const session = await controller.createSession({ scope: { user: "a" } });
      const first = await session.thread.create();
      const callSession = () =>
        operation === "rename"
          ? session.thread.rename("new")
          : operation === "delete"
            ? session.thread.delete()
            : session.thread.fork();
      await expect(callSession().then(() => {})).rejects.toMatchObject({
        code: "OperationDenied",
      });
      expect(await getThread(controller, first.id)).not.toBeNull();
      expect(order).toEqual(["before"]);
      deny = false;
      await callSession();
      expect(order).toEqual(["before", "before", "after"]);
      const second = await createThread(controller, { scope: { user: "a" } });
      const callDirect = () =>
        operation === "rename"
          ? renameThread(controller, second.id, "new")
          : operation === "delete"
            ? deleteThread(controller, second.id)
            : forkThread(controller, second.id);
      await callDirect();
      expect(order.slice(-2)).toEqual(["before", "after"]);
      const foreign = await createThread(controller, { scope: { user: "b" } });
      const previous = order.length;
      await expect(
        operation === "rename"
          ? renameThread(controller, foreign.id, "bad", {
              scope: { user: "a" },
            })
          : operation === "delete"
            ? deleteThread(controller, foreign.id, { scope: { user: "a" } })
            : forkThread(controller, foreign.id, { scope: { user: "a" } }),
      ).rejects.toMatchObject({ code: "ThreadNotFound" });
      expect(order).toHaveLength(previous);
      expect(controller.diagnostics).toEqual([]);
    } finally {
      await controller.dispose();
    }
  },
);

it("rejects concurrent controls and close while an asynchronous selection policy is pending", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    reached = new Promise<void>((resolve) => (entered = resolve));
  const { controller } = await fixture(
    [],
    [
      {
        id: "slow",
        setup(tessar) {
          tessar.hook(hooks.session.model.beforeChange, async () => {
            entered();
            await gate;
          });
        },
      },
    ],
  );
  try {
    const session = await controller.createSession();
    const first = await session.thread.create();
    const selecting = session.model.switch("scripted/second");
    await reached;
    expect(session.model.get()).toBe("scripted/test");
    await expect(session.model.switch("scripted/test")).rejects.toMatchObject({
      code: "SessionBusy",
    });
    await expect(session.thread.create()).rejects.toMatchObject({
      code: "SessionBusy",
    });
    await expect(session.dispose()).rejects.toMatchObject({
      code: "SessionBusy",
    });
    expect(session.thread.getId()).toBe(first.id);
    release();
    await selecting;
    expect(session.model.name()).toBe("second");
  } finally {
    release();
    await controller.dispose();
  }
});

it("provides Session and Thread capabilities to the execution belonging to that Session", async () => {
  const seen: { session: unknown; threadId: string }[] = [];
  const { controller } = await fixture(
    [{ text: "one" }, { text: "two" }],
    [
      {
        id: "context",
        setup(tessar) {
          tessar.hook(hooks.input.prepare, (event, context) => {
            seen.push({
              session: context.session,
              threadId: context.thread!.id,
            });
            return event.payload;
          });
        },
      },
    ],
  );
  try {
    const a = await controller.createSession({ scope: { user: "a" } }),
      b = await controller.createSession({ scope: { user: "b" } });
    const ta = await a.thread.create(),
      tb = await b.thread.create();
    const run = async (session: typeof a) => {
      const done = new Promise<void>((resolve, reject) => {
        const off = session.subscribe((event) => {
          if (event.type === hooks.stream.end) {
            off();
            resolve();
          }
          if (event.type === hooks.stream.error) {
            off();
            reject(new Error(event.payload.error.message));
          }
        });
      });
      await session.followUp(new hooks.HumanMessage("hello"));
      await done;
    };
    await run(a);
    await run(b);
    expect(seen).toEqual([
      { session: a, threadId: ta.id },
      { session: b, threadId: tb.id },
    ]);
    expect(JSON.stringify(await a.thread.getHistory())).not.toContain(
      '"controller"',
    );
  } finally {
    await controller.dispose();
  }
});

it("refreshes target activity after an awaited thread-switch policy before admitting queued input", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let startTarget!: () => Promise<void>;
  const { controller } = await fixture(
    [{ text: "owner", gate }],
    [
      {
        id: "switch-policy",
        setup(tessar) {
          tessar.hook(hooks.session.thread.beforeSwitch, () => startTarget());
        },
      },
    ],
  );
  try {
    const owner = await controller.createSession(),
      viewer = await controller.createSession();
    const target = await owner.thread.create();
    const started = new Promise<void>((resolve) =>
      owner.subscribe(hooks.model.start, () => resolve()),
    );
    const finished = new Promise<void>((resolve) =>
      owner.subscribe(hooks.stream.end, () => resolve()),
    );
    startTarget = async () => {
      await owner.followUp(new hooks.HumanMessage("owner"));
      await started;
    };
    await viewer.thread.switch(target.id);
    const errors: string[] = [];
    viewer.subscribe(hooks.stream.error, (event) =>
      errors.push(event.payload.error.code),
    );
    await viewer.followUp(new hooks.HumanMessage("queued"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors).toEqual([]);
    release();
    await finished;
  } finally {
    release();
    await controller.dispose();
  }
});

it.each(["session", "thread"] as const)(
  "preserves %s hook capabilities when cancelling a suspended execution",
  async (caller) => {
    const pause = hooks.defineInterruption({
      id: "pause",
      version: 1,
      response: { jsonSchema: {}, parse: () => ({}) },
      resolve: () => hooks.ToolDecision.allow(),
    });
    const seen: { session: unknown; threadId?: string }[] = [];
    const { controller } = await fixture(
      [],
      [
        {
          id: "cancel-context",
          setup(tessar) {
            tessar.interruptions.register(pause);
            tessar.hook(hooks.stream.before, (_, context) =>
              context.suspend(pause, {}),
            );
            tessar.hook(hooks.stream.cancel, (_, context) => {
              seen.push({
                session: context.session,
                threadId: context.thread?.id,
              });
            });
          },
        },
      ],
    );
    try {
      const session = await controller.createSession();
      const thread = await session.thread.create();
      const suspended = new Promise<void>((resolve) =>
        session.subscribe(hooks.stream.suspended, () => resolve()),
      );
      await session.followUp(new hooks.HumanMessage("pause"));
      await suspended;
      await new Promise((resolve) => setImmediate(resolve));
      if (caller === "session") await session.abort();
      else await thread.cancelStream((await thread.snapshot()).activeStreamId!);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.threadId).toBe(thread.id);
      expect(
        seen[0]!.session === (caller === "session" ? session : undefined),
      ).toBe(true);
      expect(controller.diagnostics).toEqual([]);
    } finally {
      await controller.dispose();
    }
  },
);

it("uses the fork options approved by policy even if the caller changes its original object", async () => {
  const options = { metadata: { label: "approved" } };
  const { controller } = await fixture(
    [],
    [
      {
        id: "snapshot",
        setup(tessar) {
          tessar.hook(hooks.thread.beforeFork, (event) => {
            expect(event.payload.options.metadata?.label).toBe("approved");
            options.metadata.label = "changed during policy";
          });
        },
      },
    ],
  );
  try {
    const source = await createThread(controller);
    const fork = await forkThread(controller, source.id, options);
    expect((await fork.snapshot()).state.metadata.label).toBe("approved");
  } finally {
    await controller.dispose();
  }
});

it.each(["fork", "rename", "delete"] as const)(
  "does not emit thread %s success when storage fails",
  async (operation) => {
    const backend = hooks.createMemoryBackend();
    let failWrite = false;
    const publish = backend.commits.publish.bind(backend.commits);
    backend.commits.publish = async (...args) => {
      if (failWrite) throw Error("storage failed");
      return publish(...args);
    };
    const seen: string[] = [];
    const { controller } = await fixture(
      [],
      [
        {
          id: "storage",
          setup(tessar) {
            tessar.storage.register(backend);
            tessar.hook(hooks.thread.forked, (event) => {
              seen.push(event.type);
            });
            tessar.hook(hooks.thread.renamed, (event) => {
              seen.push(event.type);
            });
            tessar.hook(hooks.thread.deleted, (event) => {
              seen.push(event.type);
            });
          },
        },
      ],
    );
    try {
      const thread = await createThread(controller);
      failWrite = true;
      await expect(
        (operation === "fork"
          ? forkThread(controller, thread.id)
          : operation === "rename"
            ? renameThread(controller, thread.id, "new")
            : deleteThread(controller, thread.id)
        ).then(() => {}),
      ).rejects.toThrow("storage failed");
      expect(seen).toEqual([]);
      expect(await getThread(controller, thread.id)).not.toBeNull();
    } finally {
      await controller.dispose();
    }
  },
);

it("awaits model policy, keeps selection on denial and exposes the correct Session", async () => {
  let deny = true;
  const seen: string[] = [];
  let expectedSession: any;
  const { controller } = await fixture(
    [],
    [
      {
        id: "model-policy",
        setup(tessar) {
          tessar.hook(
            hooks.session.model.beforeChange,
            async (event, context) => {
              expect(context.session).toBe(expectedSession);
              expect(context.session.model.get()).toBe(
                event.payload.previous.providerId +
                  "/" +
                  event.payload.previous.modelId,
              );
              await Promise.resolve();
              return deny ? { decision: "deny" } : { decision: "allow" };
            },
          );
          tessar.hook(hooks.session.modelChanged, (event) => {
            seen.push(event.payload.model.modelId);
          });
        },
      },
    ],
  );
  try {
    const session = await controller.createSession();
    expectedSession = session;
    await expect(session.model.switch("scripted/second")).rejects.toMatchObject(
      { code: "OperationDenied" },
    );
    expect(session.model.get()).toBe("scripted/test");
    expect(seen).toEqual([]);
    deny = false;
    await session.model.switch("scripted/second");
    expect(session.model.name()).toBe("second");
    expect(seen).toEqual(["second"]);
  } finally {
    await controller.dispose();
  }
});

it("keeps thread selection on denied switch and rejects reentrant control without deadlock", async () => {
  let deny = true;
  const changed: string[] = [];
  let firstId: string;
  const { controller } = await fixture(
    [],
    [
      {
        id: "switch-policy",
        setup(tessar) {
          tessar.hook(
            hooks.session.thread.beforeSwitch,
            async (event, context) => {
              expect(event.payload.previousThreadId).toBe(firstId);
              await expect(
                context.session.model.switch("scripted/test"),
              ).rejects.toMatchObject({ code: "SessionBusy" });
              return deny ? { decision: "deny" } : { decision: "allow" };
            },
          );
          tessar.hook(hooks.session.threadSwitched, (event) => {
            changed.push(event.payload.threadId);
          });
        },
      },
    ],
  );
  try {
    const session = await controller.createSession();
    firstId = (await session.thread.create()).id;
    const target = await createThread(controller);
    await expect(session.thread.switch(target.id)).rejects.toMatchObject({
      code: "OperationDenied",
    });
    expect(session.thread.getId()).toBe(firstId);
    expect(changed).toEqual([]);
    deny = false;
    await session.thread.switch(target.id);
    expect(session.thread.getId()).toBe(target.id);
    expect(changed).toEqual([target.id]);
  } finally {
    await controller.dispose();
  }
});

it("rejects an unsupported operation decision before a later handler can hide it", async () => {
  let later = false;
  const { controller } = await fixture(
    [],
    [
      {
        id: "invalid",
        setup(tessar) {
          tessar.hook(hooks.thread.beforeDelete, (() => ({
            decision: "suspend",
          })) as any);
          tessar.hook(hooks.thread.beforeDelete, () => {
            later = true;
            return { decision: "allow" };
          });
        },
      },
    ],
  );
  try {
    const thread = await createThread(controller);
    await expect(deleteThread(controller, thread.id)).rejects.toMatchObject({
      code: "InvalidHookResult",
    });
    expect(later).toBe(false);
    expect(await getThread(controller, thread.id)).not.toBeNull();
  } finally {
    await controller.dispose();
  }
});
