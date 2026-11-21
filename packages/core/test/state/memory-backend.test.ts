import { storageConformance } from "../../src/testing/storage-conformance.js";
import { createMemoryBackend } from "../../src/state/memory-backend.js";
import { expect, it } from "vitest";
import { queryObjects } from "node:v8";
import { CommitCoordinator } from "../../src/state/commit.js";
import { HumanMessage, MessageCodec } from "../../src/index.js";
import { initialBatch } from "../../src/testing/storage-conformance.js";
import { aggregateUsage } from "../../src/trace/usage.js";
storageConformance("memory backend", async () => createMemoryBackend());

it("reuses unchanged immutable messages across checkpoints while isolating edits and caller data", async () => {
  const backend = createMemoryBackend();
  const commit = new CommitCoordinator(backend);
  const first = initialBatch();
  first.checkpoint.state.messages = [MessageCodec.encode(new HumanMessage("history", { id: "message" }))];
  first.records = [{ kind: "streams", id: "stream", threadId: "t1", data: {
    id: "stream", threadId: "t1", scope: {}, status: "completed", triggerMessageId: null,
    stopReason: null, startedAt: first.checkpoint.createdAt, endedAt: first.checkpoint.createdAt,
    durationMs: 0, error: null, directUsage: aggregateUsage([]), outputMessageIds: [],
  } }];
  const lease = await backend.ownership.acquire({ threadId: "t1", ownerToken: "owner", ttlMs: 60000 });
  try {
    await commit.commit(first, lease);
    const saved = (await backend.checkpoints.get("cp-t1"))!;
    const savedStream = await backend.executions.get("streams", "stream", { threadId: "t1", atCheckpointId: "cp-t1" });
    const second = structuredClone(first);
    second.commitId = "second";
    Object.assign(second.checkpoint, { id: "second-cp", parentCheckpointId: "cp-t1", revision: 2 });
    second.expectedRevision = 1;
    await commit.commit(second, lease);
    expect((await backend.checkpoints.get("second-cp"))!.state.messages[0]).toBe(saved.state.messages[0]);
    expect(await backend.executions.get("streams", "stream", { threadId: "t1", atCheckpointId: "second-cp" })).toBe(savedStream);
    second.checkpoint.state.messages = [MessageCodec.encode(new HumanMessage("edited", { id: "message" }))];
    second.commitId = "third";
    Object.assign(second.checkpoint, { id: "third-cp", parentCheckpointId: "second-cp", revision: 3 });
    second.expectedRevision = 2;
    await commit.commit(second, lease);
    second.checkpoint.state.messages = [];
    expect((await backend.checkpoints.get("third-cp"))!.state.messages[0]!.content).toEqual([{ type: "text", text: "edited" }]);
    expect(saved.state.messages[0]!.content).toEqual([{ type: "text", text: "history" }]);
  } finally { await backend.close(); }
});

it("releases owned plugin state when the backend closes even if its handle is retained", async () => {
  const backend = createMemoryBackend();
  async function seed() {
    const key = { ownerType: "agent" as const, ownerId: "a", pluginId: "test", namespace: "cache" };
    await backend.ownedState.compareAndSet({ ...key, revision: 1, schemaVersion: 1, data: { payload: "owned" } }, 0);
    return new WeakRef((await backend.ownedState.get(key))!);
  }
  const state = await seed();
  await backend.close();
  await new Promise<void>(resolve => setImmediate(resolve));
  queryObjects(Object);
  expect(state.deref()).toBeUndefined();
  await expect(backend.ownedState.get({ ownerType: "agent", ownerId: "a", pluginId: "test", namespace: "cache" })).rejects.toMatchObject({ code: "Disposed" });
});
