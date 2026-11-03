import { expect, it } from "vitest";
import { AgentHarness } from "../../src/testing/harness.js";
import { createMemoryBackend } from "../../src/state/memory-backend.js";
import { MessageCodec } from "../../src/messages/codec.js";
import { HumanMessage } from "../../src/messages/message.js";

it("stages changed execution records without replaying historical traces", async () => {
  const backend = createMemoryBackend();
  const stage = backend.commits.stage.bind(backend.commits);
  const batches: { records: number; bytes: number; messageBytes: number; ids: string[] }[] = [];
  const versions = new Map<string, string>();
  backend.commits.stage = async batch => {
    for (const record of batch.records) {
      const key = record.kind + ":" + record.id;
      const version = JSON.stringify(record);
      expect(version).not.toBe(versions.get(key));
      versions.set(key, version);
    }
    batches.push({ records: batch.records.length, bytes: JSON.stringify(batch.records).length,
      messageBytes: JSON.stringify(batch.checkpoint.state.messages).length,
      ids: batch.records.map(record => record.id) });
    return stage(batch);
  };
  const h = await AgentHarness.create({ backend,
    modelScripts: Array.from({ length: 100 }, () => ({ text: "ok", usage: { inputTokens: 2, outputTokens: 1 } })),
  });
  try {
    const thread = await h.createThread();
    const counts: number[] = [], bytes: number[] = [], messageBytes: number[] = [];
    let first!: Awaited<ReturnType<typeof h.records>>;
    for (let index = 0; index < 100; index++) {
      const begin = batches.length;
      const stream = h.admit({ kind: "input", threadId: thread.id,
        input: [MessageCodec.encode(new HumanMessage("hi"))], model: h.provider.ref });
      await h.collect(stream);
      const records = await h.records(stream.id!);
      expect(records.stream.directUsage.metrics.inputTokens.knownTotal).toBe(2);
      expect(records.stream.directUsage.metrics.outputTokens.knownTotal).toBe(1);
      expect(records.turns[0]!.usage).toEqual(records.stream.directUsage);
      const staged = batches.slice(begin);
      counts.push(staged.reduce((sum, batch) => sum + batch.records, 0));
      bytes.push(staged.reduce((sum, batch) => sum + batch.bytes, 0));
      messageBytes.push(staged.reduce((sum, batch) => sum + batch.messageBytes, 0));
      if (index === 0) first = records;
      else expect(staged.flatMap(batch => batch.ids)).not.toContain(first.stream.id);
    }
    expect(Math.max(...counts)).toBe(Math.min(...counts));
    expect(Math.max(...bytes)).toBeLessThan(Math.min(...bytes) * 1.1);
    expect(messageBytes.at(-1)).toBeGreaterThan(messageBytes[0]! * 50);
    expect(await backend.executions.get("streams", first.stream.id)).toEqual(first.stream);
    expect(await backend.executions.get("turns", first.turns[0]!.id)).toEqual(first.turns[0]);
    expect((await h.checkpoint(thread.id)).state.messages).toHaveLength(200);
  } finally { await h.dispose(); }
});
