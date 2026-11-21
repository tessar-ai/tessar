import { expect, it } from "vitest";
import { HumanMessage, MessageCodec, checkpoint } from "../../src/index.js";
import type { Checkpoint } from "../../src/state/schema.js";
import { AgentHarness } from "../../src/testing/harness.js";

it("shares unchanged immutable history while keeping retained checkpoints stable", async () => {
  const h = await AgentHarness.create({ modelScripts: [{ text: "answer" }] });
  try {
    const thread = await h.createThread({ messages: [MessageCodec.encode(new HumanMessage("history", { id: "old" }))] });
    const snapshots: { checkpoint: Checkpoint; saved: Checkpoint }[] = [];
    const stage = h.backend.commits.stage.bind(h.backend.commits);
    h.backend.commits.stage = async batch => {
      snapshots.push({ checkpoint: batch.checkpoint, saved: structuredClone(batch.checkpoint) });
      return stage(batch);
    };
    await h.collect(h.admit({
      kind: "input", threadId: thread.id, model: h.provider.ref,
      input: [MessageCodec.encode(new HumanMessage("question", { id: "input" }))]
    }));
    expect(h.provider.calls).toHaveLength(1);
    expect((await h.checkpoint(thread.id)).state.messages.map(message => message.id)).toContain("input");
    const histories = new Map<string, Checkpoint["state"]["messages"]>();
    let shared = 0;
    for (const { checkpoint: cp, saved } of snapshots) {
      const key = cp.state.messages.map(message => message.id).join(",");
      expect(cp).toEqual(saved);
      expect(Object.isFrozen(cp.state.messages)).toBe(true);
      const previous = histories.get(key);
      if (previous) { expect(cp.state.messages).toBe(previous); shared++; }
      histories.set(key, cp.state.messages);
    }
    expect(shared).toBeGreaterThan(0);
    const first = snapshots[0]!.checkpoint;
    expect(first.execution!.budgets.modelAttempts).toBe(0);
    expect(first.state.messages.map(message => message.id)).toEqual(["old", "input"]);
    expect(snapshots.at(-1)!.checkpoint.state.messages).not.toBe(first.state.messages);
  } finally { await h.dispose(); }
});

it("keeps clone isolation for opaque mutable descendants outside the proven JSON graph", async () => {
  let retained: Checkpoint | undefined;
  const h = await AgentHarness.create({
    modelScripts: [{ text: "answer" }], plugins: [{
      id: "retained-storage",
      setup(context) {
        context.hook(checkpoint.committed, () => {
          const content = retained?.state.messages[0]?.content as unknown as { extra?: Date } | undefined;
          content?.extra?.setTime(999);
        });
      },
    }]
  });
  try {
    const content = Object.assign([{ type: "text" as const, text: "history" }], { extra: new Date(0) });
    const thread = await h.createThread({ messages: [MessageCodec.encode(new HumanMessage(content))] });
    const dates: number[] = [];
    const stage = h.backend.commits.stage.bind(h.backend.commits);
    h.backend.commits.stage = async batch => {
      retained = batch.checkpoint;
      dates.push((batch.checkpoint.state.messages[0]!.content as unknown as { extra: Date }).extra.getTime());
      return stage(batch);
    };
    await h.collect(h.admit({
      kind: "input", threadId: thread.id, model: h.provider.ref,
      input: [MessageCodec.encode(new HumanMessage("question"))]
    }));
    expect(dates.length).toBeGreaterThan(1);
    expect(dates.every(value => value === 0)).toBe(true);
  } finally { await h.dispose(); }
});
