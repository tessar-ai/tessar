import { expect, it } from "vitest";
import { thread, session, stream, message } from "../../src/events/type.js";
import { AgentHarness } from "../../src/testing/harness.js";

it("removes redundant event maps and handle barriers", () => {
  const values = JSON.stringify([thread, session, stream, message]);
  for (const name of [
    "thread.updated",
    "tools.select",
    "session.thread-created",
    "session.thread-renamed",
    "session.thread-forked",
    "session.thread-deleted",
    "thread.shutdown",
    "thread.before-shutdown",
    "session.before-close",
    "stream.before-end",
    "message.before-commit",
  ])
    expect(values).not.toContain(name);
});

it("validates context-prepared tools against the actual registry", async () => {
  const h = await AgentHarness.create({
    modelScripts: [{ text: "answer" }],
    plugins: [
      {
        id: "invalid-tool",
        setup(tessar) {
          tessar.hook("context.prepare", (event) => ({
            ...event.payload,
            tools: [
              { name: "unregistered", description: "invalid", inputSchema: {} },
            ],
          }));
        },
      },
    ],
  });
  try {
    const result = await h.agent.generate("go");
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "UnknownTool" },
    });
    expect(h.provider.calls).toHaveLength(0);
  } finally {
    await h.dispose();
  }
});

it("publishes one Thread mutation event with already-updated Session state", async () => {
  const seen: string[] = [];
  const h = await AgentHarness.create({
    plugins: [
      {
        id: "observe",
        setup(tessar) {
          tessar.hook("thread.started", (event, ctx) => {
            if (ctx.session)
              expect(ctx.session.thread.getId()).toBe(event.payload.id);
            seen.push("hook:create");
          });
          tessar.hook("thread.renamed", () => {
            seen.push("hook:rename");
          });
          tessar.hook("thread.forked", () => {
            seen.push("hook:fork");
          });
          tessar.hook("thread.deleted", (_event, ctx) => {
            expect(ctx.session?.thread.getId()).toBeNull();
            seen.push("hook:delete");
          });
        },
      },
    ],
  });
  try {
    const current = await h.controller.createSession();
    current.subscribe("thread.started", (event) => {
      expect(current.thread.getId()).toBe(event.payload.id);
      seen.push("ui:create");
    });
    current.subscribe("thread.renamed", () => {
      seen.push("ui:rename");
    });
    current.subscribe("thread.forked", () => {
      seen.push("ui:fork");
    });
    current.subscribe("thread.deleted", () => {
      seen.push("ui:delete");
    });
    const created = await current.thread.create();
    await current.thread.rename("title");
    await current.thread.fork();
    expect(current.thread.getId()).toBe(created.id);
    await current.thread.delete();
    expect(seen.sort()).toEqual([
      "hook:create",
      "hook:delete",
      "hook:fork",
      "hook:rename",
      "ui:create",
      "ui:delete",
      "ui:fork",
      "ui:rename",
    ]);
  } finally {
    await h.dispose();
  }
});
