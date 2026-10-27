import {
  createThread,
  getThread,
  deleteThread,
  forkThread,
} from "../src/state/thread-operations.js";
import { thread as threadHooks } from "../src/index.js";
import { expect, it } from "vitest";
import { HumanMessage } from "../src/index.js";
import { fixture, fixtureRef } from "./test-fixture.js";
it("binds queries and mutations to actual Thread scope and exposes committed trace", async () => {
  const { controller } = await fixture();
  try {
    const thread = await createThread(controller, {
      scope: { user: "a" },
      title: "one",
    });
    expect(
      await getThread(controller, thread.id, { scope: { user: "b" } }),
    ).toBeNull();
    await expect(
      deleteThread(controller, thread.id, { scope: { user: "b" } }),
    ).rejects.toMatchObject({ code: "ThreadNotFound" });
    const stream = thread.stream({
      input: new HumanMessage("hello"),
      model: fixtureRef,
    });
    for await (const _ of stream) {
    }
    const rows = await thread.listStreams();
    expect(rows.items).toHaveLength(1);
    const turns = await thread.listTurns(stream.id!);
    expect(
      (await thread.listModelAttempts(turns.items[0]!.id)).items,
    ).toHaveLength(1);
    expect(
      (await thread.listToolExecutions(turns.items[0]!.id)).items,
    ).toHaveLength(0);
    expect((await thread.getHistory()).items).toHaveLength(2);
    const fork = await forkThread(controller, thread.id);
    expect((await fork.getHistory()).items).toHaveLength(2);
    expect((await fork.listStreams()).items).toHaveLength(0);
    await thread.dispose();
    expect(await getThread(controller, thread.id)).not.toBeNull();
  } finally {
    await controller.dispose();
  }
});
it("runs Thread lifecycle hooks and prevents execution from disposed handles", async () => {
  const seen: string[] = [];
  const { controller } = await fixture(
    [],
    [
      {
        id: "lifecycle",
        setup(tessar) {
          tessar.hook(threadHooks.prepare, (e) => ({
            ...e.payload,
            title: "prepared",
          }));
          tessar.hook(threadHooks.started, () => {
            seen.push("started");
          });
        },
      },
    ],
  );
  try {
    const thread = await createThread(controller);
    expect((await thread.snapshot()).state.metadata.title).toBe("prepared");
    await thread.dispose();
    expect(seen).toEqual(["started"]);
    expect(await controller.queries.getThread(thread.id)).not.toBeNull();
    expect(() =>
      thread.stream({ input: new HumanMessage("ask"), model: fixtureRef }),
    ).toThrow();
  } finally {
    await controller.dispose();
  }
});
