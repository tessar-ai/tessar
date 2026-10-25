import { expect, it } from "vitest";
import { HumanMessage, session as events, stream } from "../src/index.js";
import { fixture } from "./test-fixture.js";

it("applies generic option ownership equally while leaving provider-specific options to the provider", async () => {
  const { agent, controller, provider } = await fixture([{ text: "direct" }, { text: "session" }]);
  const options = { background: true, conversation: "custom", previous_response_id: "custom-id" };
  try {
    expect((await agent.generate("hello", { modelOptions: options })).status).toBe("completed");
    const session = await controller.createSession({ threadId: "options" });
    await session.model.switch("test", options);
    const done = new Promise<void>((resolve) => { const stop = session.subscribe("stream.end", () => { stop(); resolve(); }); });
    await session.followUp("hello");
    await done;
    expect(provider.calls.map((request) => request.options)).toEqual([options, options]);
    await expect(agent.generate("bad", { modelOptions: { connectionId: "transport" } })).rejects.toMatchObject({ code: "UnsupportedOption" });
    await expect(session.model.switch("test", { connectionId: "transport" })).rejects.toMatchObject({ code: "UnsupportedOption" });
  } finally { await controller.dispose(); }
});

it("normalizes follow-up strings to user messages and persists them", async () => {
  const { controller, provider } = await fixture([
    { text: "one" },
    { text: "two" },
  ]);
  try {
    const session = await controller.createSession();
    await session.thread.create();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let completed = 0;
    session.subscribe(stream.end, () => {
      if (++completed === 2) finish();
    });
    await session.followUp("Hello");
    await session.followUp("");
    await done;
    const users = (await session.thread.getHistory()).items.filter(
      (message) => message.role === "user",
    );
    expect(users.map((message) => message.content)).toEqual([
      [{ type: "text", text: "Hello" }],
      [{ type: "text", text: "" }],
    ]);
    expect(provider.calls[0]!.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    });
    expect(provider.calls[1]!.messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "" }],
    });
  } finally {
    await controller.dispose();
  }
});

it("exposes model/thread operations only through Session", async () => {
  const { controller } = await fixture();
  try {
    for (const name of [
      "models",
      "createThread",
      "getThread",
      "listThreads",
      "renameThread",
      "forkThread",
      "deleteThread",
      "purgeThread",
    ])
      expect(controller).not.toHaveProperty(name);
    const session = await controller.createSession({ scope: { user: "one" } });
    expect(session.model.get()).toBe("scripted/test");
    expect(session.model.name()).toBe("test");
    expect(session.model.list()).toContainEqual(
      expect.objectContaining({ id: "scripted/test", name: "test" }),
    );
    expect(session.model).not.toHaveProperty("set");
    expect(session).not.toHaveProperty("setModel");
    const thread = await session.thread.create({
      title: "one",
      messages: [new HumanMessage("seed")],
      metadata: { project: "a" },
    });
    expect(thread.scope()).toEqual({ user: "one" });
    expect(session.scope()).toEqual({ user: "one" });
    expect(session.metadata()).toEqual({});
    expect((await thread.getHistory()).items).toHaveLength(1);
    await expect(
      session.thread.create({ instructions: "forbidden" } as never),
    ).rejects.toMatchObject({ code: "InvalidConfiguration" });
    await session.thread.delete();
    await session.thread.purge({ threadId: thread.id });
    expect(session.thread.getId()).toBeNull();
    expect(await session.thread.get(thread.id)).toBeNull();
    if (false) {
      // @ts-expect-error The registry is not Controller's public API.
      controller.models;
      // @ts-expect-error Thread management belongs to Session.
      controller.createThread();
      // @ts-expect-error Instructions are configured on Agent or via hooks.
      session.thread.create({ instructions: "no" });
    }
  } finally {
    await controller.dispose();
  }
});

it("authorizes and persists options before publishing a model change", async () => {
  let deny = false;
  const seen: string[] = [];
  const { controller } = await fixture(
    [],
    [
      {
        id: "model-policy",
        setup(tessar) {
          tessar.hook(events.model.beforeChange, (event) => {
            seen.push("before");
            expect(event.payload.options).toEqual({ temperature: 0.3 });
            return deny ? { decision: "deny" } : { decision: "allow" };
          });
        },
      },
    ],
  );
  try {
    const session = await controller.createSession();
    session.subscribe(events.modelChanged, (event) => {
      seen.push("after");
      expect(session.model.name()).toBe(event.payload.model.modelId);
      expect(event.payload.options).toEqual({ temperature: 0.3 });
    });
    await session.model.switch("scripted/test", { temperature: 0.3 });
    expect(
      (await controller.backend.sessions.get(session.id))!.selectedModel
        .options,
    ).toEqual({ temperature: 0.3 });
    expect(seen).toEqual(["before", "after"]);
    deny = true;
    await expect(
      session.model.switch("scripted/second", { temperature: 0.3 }),
    ).rejects.toMatchObject({ code: "OperationDenied" });
    expect(session.model.get()).toBe("scripted/test");
    expect(seen).toEqual(["before", "after", "before"]);
  } finally {
    await controller.dispose();
  }
});

it("snapshots queued options and replaces previous overrides on the next switch", async () => {
  const { controller, provider } = await fixture([
    { text: "one" },
    { text: "two" },
  ]);
  try {
    const session = await controller.createSession();
    await session.thread.create();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let completed = 0;
    session.subscribe(stream.end, () => {
      if (++completed === 2) finish();
    });
    await session.model.switch("scripted/test", {
      temperature: 0.2,
      reasoning: { effort: "high" },
    });
    await session.followUp(new HumanMessage("first"));
    await session.model.switch("scripted/second", { temperature: 0.4 });
    await session.followUp(new HumanMessage("second"));
    await done;
    expect(provider.calls.map((call) => call.options)).toEqual([
      { temperature: 0.2, reasoning: { effort: "high" } },
      { temperature: 0.4 },
    ]);
    expect(provider.calls.map((call) => call.model.modelId)).toEqual([
      "test",
      "second",
    ]);
    const restored = await controller.getSession(session.id);
    expect(restored!.model.get()).toBe("scripted/second");
    await restored!.model.switch("scripted/second");
    expect(
      (await controller.backend.sessions.get(session.id))!.selectedModel
        .options,
    ).toBeUndefined();
  } finally {
    await controller.dispose();
  }
});

it("rejects transport options without persisting credentials or publishing a change", async () => {
  const { controller } = await fixture();
  try {
    const session = await controller.createSession();
    let changed = 0;
    session.subscribe(events.modelChanged, () => {
      changed++;
    });
    await expect(
      session.model.switch("scripted/test", { apiKey: "secret" }),
    ).rejects.toMatchObject({ code: "UnsupportedOption" });
    await expect(session.model.switch("missing/model")).rejects.toMatchObject({
      code: "MissingProvider",
    });
    expect(changed).toBe(0);
    expect(
      (await controller.backend.sessions.get(session.id))!.selectedModel
        .options,
    ).toBeUndefined();
  } finally {
    await controller.dispose();
  }
});

it("switches registered connections with native slash IDs and replaces nested defaults", async () => {
  const { controller } = await fixture(
    [],
    [
      {
        id: "other-provider",
        setup(tessar) {
          tessar.models.register({
            id: "gateway",
            create: (modelId) => ({
              ref: {
                providerId: "gateway",
                modelId,
                connectionId: "configured-endpoint",
              },
              options: {
                reasoning: { effort: "low", summary: "auto" },
                temperature: 0.1,
              },
              validate() {},
              async *stream() {
                throw Error("Not executed");
              },
            }),
          });
        },
      },
    ],
  );
  try {
    const session = await controller.createSession();
    await session.model.switch("gateway/vendor/first", {
      reasoning: { effort: "high" },
    });
    expect(session.model.get()).toBe("gateway/vendor/first");
    expect(session.model.name()).toBe("vendor/first");
    expect(
      (await controller.backend.sessions.get(session.id))!.selectedModel,
    ).toMatchObject({
      ref: { connectionId: "configured-endpoint" },
      options: { reasoning: { effort: "high" }, temperature: 0.1 },
    });
    await session.model.switch("second");
    expect(
      (await controller.backend.sessions.get(session.id))!.selectedModel,
    ).toMatchObject({
      ref: { modelId: "second", connectionId: "configured-endpoint" },
      options: {
        reasoning: { effort: "low", summary: "auto" },
        temperature: 0.1,
      },
    });
    expect(Object.isFrozen(session.model.list())).toBe(true);
  } finally {
    await controller.dispose();
  }
});

it("keeps model selection and success events unchanged when persistence fails", async () => {
  const { controller } = await fixture();
  try {
    const session = await controller.createSession();
    const changed: string[] = [];
    session.subscribe(events.modelChanged, () => changed.push("changed"));
    controller.backend.sessions.compareAndSet = async () => {
      throw Error("disk unavailable");
    };
    await expect(
      session.model.switch("second", { temperature: 0.5 }),
    ).rejects.toThrow("disk unavailable");
    expect(session.model.get()).toBe("scripted/test");
    expect(changed).toEqual([]);
  } finally {
    await controller.dispose();
  }
});

it("provides Session context to thread policies and guards thread selection during queued work", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: string[] = [];
  const { controller } = await fixture(
    [{ text: "one", gate }, { text: "two" }],
    [
      {
        id: "thread-policy",
        setup(tessar) {
          for (const name of [
            "thread.prepare",
            "thread.started",
            "thread.before-rename",
            "thread.renamed",
            "thread.before-fork",
            "thread.forked",
            "thread.before-delete",
            "thread.deleted",
          ] as const)
            tessar.hook(name, (event, context) => {
              expect(context.session?.id).toBe(event.sessionId);
              expect(event.sessionId).toBeDefined();
              seen.push(name);
            });
        },
      },
    ],
  );
  try {
    const session = await controller.createSession();
    const source = await session.thread.create();
    await session.thread.rename("renamed");
    const fork = await session.thread.fork();
    expect(session.thread.getId()).toBe(source.id);
    await session.thread.delete({ threadId: fork.id });
    expect(seen).toHaveLength(8);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let count = 0;
    session.subscribe(stream.end, () => {
      if (++count === 2) finish();
    });
    await session.followUp(new HumanMessage("one"));
    await session.followUp(new HumanMessage("two"));
    await expect(session.thread.create()).rejects.toMatchObject({
      code: "SessionBusy",
    });
    await expect(session.thread.switch(source.id)).rejects.toMatchObject({
      code: "SessionBusy",
    });
    release();
    await done;
  } finally {
    release();
    await controller.dispose();
  }
});
