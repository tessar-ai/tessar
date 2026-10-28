import { expect, it } from "vitest";
import { AgentHarness } from "../../src/testing/harness.js";
import { buildInstruction } from "../../src/instructions/instruction.js";
import { start, delta } from "../part-fixture.js";

it("publishes interrupted helper parts on early return while keeping auxiliary drafts out of UI", async () => {
  const h = await AgentHarness.create({
    modelScripts: [
      { text: "public" },
      { chunks: [start("helper"), delta("helper", "private")] },
    ],
    plugins: [
      {
        id: "helper",
        setup(tessar) {
          tessar.hook("turn.decision", async (_event, ctx) => {
            for await (const chunk of ctx.models.stream({
              model: { providerId: "scripted", modelId: "test" },
              instructions: buildInstruction([]),
              messages: [],
              tools: [],
            }))
              if (chunk.type === "text.delta") break;
          });
        },
      },
    ],
  });
  try {
    const stream = h.agent.stream("go");
    const events = await h.collect(stream);
    expect(
      events.find(
        (event) =>
          event.type === "text.end" && event.payload.purpose === "auxiliary",
      )!.payload,
    ).toMatchObject({
      messageId: "helper",
      status: "interrupted",
      text: "private",
    });
    expect(
      (await h.records(stream.id!)).attempts.find(
        (record) => record.purpose === "auxiliary",
      )!.status,
    ).toBe("interrupted");
    const snapshots = events
      .filter((event) => event.type === "state_changed")
      .map((event) => event.payload.state);
    expect(JSON.stringify(snapshots)).not.toContain("private");
    expect(snapshots.at(-1)!.status).toBe("completed");
  } finally {
    await h.dispose();
  }
});
it("marks failed primary drafts before model.error and keeps UI status out of checkpoints", async () => {
  const h = await AgentHarness.create({
    modelScripts: [
      {
        chunks: [start("failed"), delta("failed", "partial")],
        error: Error("network"),
      },
    ],
  });
  try {
    const stream = h.agent.stream("go");
    const events = await h.collect(stream);
    expect(events.findIndex((event) => event.type === "text.end")).toBeLessThan(
      events.findIndex((event) => event.type === "model.error"),
    );
    const state = events
      .filter((event) => event.type === "state_changed")
      .at(-1)!.payload.state;
    expect(state.currentMessage!.content[0]).toMatchObject({
      status: "interrupted",
      text: "partial",
    });
    const checkpoint = await h.queries.snapshot(stream.threadId!);
    expect(
      checkpoint!.state.messages.some((message) => message.id === "failed"),
    ).toBe(false);
  } finally {
    await h.dispose();
  }
});
it("cancels at the shared chunk boundary even when an adapter does not inspect the abort signal", async () => {
  let active: import("../../src/agent.js").Stream;
  const h = await AgentHarness.create({
    modelScripts: [{ text: "answer" }],
    plugins: [
      {
        id: "cancel-part",
        setup(tessar) {
          tessar.hook("text.delta", () => active.abort("stop"));
        },
      },
    ],
  });
  try {
    active = h.agent.stream("go");
    const events = await h.collect(active);
    expect((await h.records(active.id!)).attempts[0]!.status).toBe("cancelled");
    expect(
      events.find((event) => event.type === "text.end")!.payload,
    ).toMatchObject({ status: "interrupted" });
  } finally {
    await h.dispose();
  }
});
