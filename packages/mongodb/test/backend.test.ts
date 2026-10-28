import { AgentHarness } from "@tessar/core/testing";
import { AssistantMessage, createTool } from "@tessar/core";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Collection, MongoClient } from "mongodb";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  HumanMessage,
  MessageCodec,
  type CommitBatch,
  type SessionRecord,
  type StorageBackend,
} from "@tessar/core";
import { CommitCoordinator } from "../../core/src/state/commit.js";
import { ForkService } from "../../core/src/state/fork.js";
import { ThreadService } from "../../core/src/state/threads.js";
import {
  initialBatch,
  storageConformance,
} from "@tessar/core/testing/storage-conformance";
import { createMongoDBBackend } from "../src/index.js";

const uri = process.env.TESSAR_TEST_MONGODB_URL;
const resources: { databaseName: string; backends: StorageBackend[] }[] = [];
async function fixture() {
  const databaseName = "tessar_test_" + randomUUID().replaceAll("-", "");
  const resource = { databaseName, backends: [] as StorageBackend[] };
  resources.push(resource);
  const open = async () => {
    const backend = await createMongoDBBackend({ uri: uri!, databaseName });
    resource.backends.push(backend);
    return backend;
  };
  return { databaseName, open, backend: await open() };
}
afterEach(async () => {
  if (!resources.length) return;
  const client = new MongoClient(uri!);
  try {
    for (const resource of resources.splice(0)) {
      for (const backend of resource.backends) await backend.close();
      if (!/^tessar_test_[a-f0-9]{32}$/.test(resource.databaseName))
        throw Error("Unsafe cleanup database");
      await client.db(resource.databaseName).dropDatabase();
    }
  } finally {
    await client.close();
  }
});
const suite = uri ? describe : describe.skip;
suite("MongoDB (TESSAR_TEST_MONGODB_URL required)", () => {
  beforeAll(async () => {
    const client = new MongoClient(uri!, { serverSelectionTimeoutMS: 5000 });
    try {
      await client.db("admin").command({ ping: 1 });
    } finally {
      await client.close();
    }
  }, 10000);
  storageConformance(
    "shared storage contract",
    async () => (await fixture()).backend,
  );

  it("adds independent records to existing databases and retains them across connections", async () => {
    const { databaseName, open } = await fixture();
    const client = new MongoClient(uri!);
    try {
      await client.connect();
      await client.db(databaseName).collection("tessar_records").drop();
    } finally { await client.close(); }
    const reopened = await open();
    const record = await reopened.records.append({ namespace: "audit", data: { answer: "allow" } });
    const other = await open();
    expect(await other.records.get("audit", record.id)).toEqual(record);
    const results = await Promise.allSettled([
      reopened.records.append({ namespace: "race", id: "one", data: 1 }),
      other.records.append({ namespace: "race", id: "one", data: 2 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "RegistrationConflict" } });
  });
  it("versions its schema, adopts unversioned data and rejects future versions without resetting data", async () => {
    const { backend, open, databaseName } = await fixture();
    const thread = await new ThreadService(backend).create({
      title: "retained",
    });
    const client = new MongoClient(uri!);
    try {
      const db = client.db(databaseName),
        metadata = db.collection<{ _id: string; version: number }>(
          "tessar_schema",
        );
      expect(await metadata.findOne({ _id: "schema" })).toMatchObject({
        version: 1,
      });
      expect(
        (await (await open()).threads.get(thread.id))!.metadata.title,
      ).toBe("retained");
      await metadata.drop();
      expect(await (await open()).threads.get(thread.id)).toEqual(thread);
      expect(await metadata.findOne({ _id: "schema" })).toMatchObject({
        version: 1,
      });
      await metadata.updateOne({ _id: "schema" }, { $set: { version: 99 } });
      const names = (await db.listCollections().toArray())
        .map((row) => row.name)
        .sort();
      await expect(open()).rejects.toMatchObject({
        code: "InvalidConfiguration",
      });
      expect(
        (await db.listCollections().toArray()).map((row) => row.name).sort(),
      ).toEqual(names);
      expect(await metadata.findOne({ _id: "schema" })).toMatchObject({
        version: 99,
      });
      expect(
        JSON.parse(
          (await db.collection("tessar_threads").findOne({ id: thread.id }))!
            .body,
        ),
      ).toEqual(thread);
    } finally {
      await client.close();
    }
  });

  it("persists an Agent tool loop and trace records across reopening", async () => {
    const { backend, open } = await fixture();
    const harness = await AgentHarness.create({
      backend,
      tools: {
        lookup: createTool({
          name: "lookup",
          description: "Lookup",
          schema: z.object({}),
          execute: () => "evidence",
        }),
      },
      modelScripts: [
        {
          response: {
            message: MessageCodec.encode(
              new AssistantMessage([
                {
                  type: "tool-call",
                  toolCallId: "call",
                  name: "lookup",
                  arguments: {},
                },
              ]),
            ),
          },
        },
        { text: "done" },
      ],
    });
    let threadId: string;
    try {
      const result = await harness.agent.generate("research");
      expect(result.status).toBe("completed");
      threadId = result.threadId;
      expect(
        await backend.executions.get("streams", result.streamId),
      ).toMatchObject({ status: "completed" });
      expect(
        await backend.executions.listRecords("model_attempts", threadId),
      ).toHaveLength(2);
      const tools = await backend.executions.listRecords(
        "tool_executions",
        threadId,
      );
      expect(tools).toHaveLength(1);
      expect(tools[0]!.result!.toolCallId).toBe("call");
    } finally {
      await harness.dispose();
    }
    const restored = await open();
    expect(
      (await restored.checkpoints.history(threadId!, {})).items.map(
        (message) => message.role,
      ),
    ).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("persists versions across reopen without copying unchanged messages", async () => {
    const { backend, open, databaseName } = await fixture(),
      service = new ThreadService(backend);
    const messages = ["one", "two", "three"].map((text) =>
      MessageCodec.encode(new HumanMessage(text)),
    );
    const thread = await service.create({ messages });
    await service.rename(thread.id, "first");
    await service.rename(thread.id, "second");
    const client = new MongoClient(uri!);
    try {
      const db = client.db(databaseName);
      expect(
        await db
          .collection("tessar_versions")
          .countDocuments({ kind: "messages" }),
      ).toBe(3);
      expect(
        await db.collection("tessar_staging_pieces").countDocuments(),
      ).toBe(0);
      expect(
        JSON.parse((await db.collection("tessar_checkpoints").findOne())!.body)
          .state,
      ).not.toHaveProperty("messages");
    } finally {
      await client.close();
    }
    const page = await backend.checkpoints.history(thread.id, { limit: 1 });
    await service.mutate(thread.id, (cp) => ({
      ...cp,
      state: {
        ...cp.state,
        messages: [
          messages[2]!,
          { ...messages[0]!, metadata: { changed: true } },
        ],
      },
    }));
    await backend.close();
    await backend.close();
    const reopened = await open();
    expect(
      (await reopened.checkpoints.get(thread.currentCheckpointId))!.state
        .messages,
    ).toEqual(messages);
    expect(
      (
        await reopened.checkpoints.history(thread.id, {
          limit: 2,
          cursor: page.nextCursor!,
        })
      ).items,
    ).toEqual(messages.slice(0, 2));
    expect(
      (await reopened.checkpoints.list(thread.id)).map(
        (cp) => cp.state.messages.length,
      ),
    ).toEqual([3, 3, 3, 2]);
  });

  it("preserves scalar scopes, UTF-8 page order and cursor bindings", async () => {
    const { backend } = await fixture(),
      coordinator = new CommitCoordinator(backend);
    for (const id of ["中", "é", "a", "A", "!"]) {
      const batch = initialBatch(id);
      batch.checkpoint.state = {
        ...batch.checkpoint.state,
        scope: { "x.$中": false },
      };
      const lease = await backend.ownership.acquire({
        threadId: id,
        ownerToken: id,
        ttlMs: 60000,
      });
      await coordinator.commit(batch, lease);
      await backend.ownership.release(lease);
    }
    await new ThreadService(backend).create({ scope: { "x.$中": "false" } });
    await new ThreadService(backend).create({ scope: { "x.$中": 0 } });
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await backend.threads.page({
        scope: { "x.$中": false },
        limit: 2,
        cursor,
      });
      ids.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(["!", "A", "a", "é", "中"]);
    const page = await backend.threads.page({
      scope: { "x.$中": false },
      limit: 1,
    });
    await expect(
      backend.threads.page({ scope: { "x.$中": 0 }, cursor: page.nextCursor! }),
    ).rejects.toMatchObject({ code: "InvalidCursor" });
    await expect(
      backend.executions.page("streams", "A", { atCheckpointId: "cp-a" }),
    ).rejects.toMatchObject({ code: "CheckpointNotFound" });
  });

  it("coordinates competing clients and fences expired, released and purged ownership", async () => {
    const { backend, open } = await fixture(),
      other = await open();
    const contenders = await Promise.allSettled(
      [backend, other].map((value, i) =>
        value.ownership.acquire({
          threadId: "race",
          ownerToken: String(i),
          ttlMs: 60000,
        }),
      ),
    );
    expect(
      contenders.filter((value) => value.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      contenders.find((value) => value.status === "rejected"),
    ).toMatchObject({ reason: { code: "OwnerActive" } });
    const lease = contenders.find(
      (value) => value.status === "fulfilled",
    )!.value;
    await backend.ownership.release(lease);
    const expired = await other.ownership.acquire({
      threadId: "race",
      ownerToken: "expires",
      ttlMs: 30,
    });
    await delay(60);
    await expect(backend.ownership.renew(expired, 1000)).rejects.toMatchObject({
      code: "OwnershipLost",
    });
    const current = await backend.ownership.acquire({
      threadId: "race",
      ownerToken: "new",
      ttlMs: 60000,
    });
    expect(current.fencingToken).toBeGreaterThan(expired.fencingToken);
    await other.ownership.release(expired);
    await new CommitCoordinator(backend).commit(initialBatch("race"), current);
    await backend.ownership.release(current);
    await new ThreadService(backend).delete("race");
    await backend.threads.purge("race");
    const afterPurge = await other.ownership.acquire({
      threadId: "race",
      ownerToken: "recreated",
      ttlMs: 60000,
    });
    expect(afterPurge.fencingToken).toBeGreaterThan(current.fencingToken);
    await expect(backend.ownership.renew(current, 60000)).rejects.toMatchObject(
      { code: "OwnershipLost" },
    );
  });

  it("serializes session CAS and thread deletion across clients", async () => {
    const { backend, open } = await fixture(),
      other = await open(),
      service = new ThreadService(backend);
    const thread = await service.create({ scope: { tenant: "one" } });
    const value: SessionRecord = {
      id: "session",
      agentId: "agent",
      scope: { tenant: "one" },
      metadata: {},
      selectedThreadId: thread.id,
      selectedModel: { ref: { providerId: "test", modelId: "test" } },
      revision: 1,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    };
    await backend.sessions.compareAndSet(value, 0);
    const results = await Promise.allSettled(
      [backend, other].map((storage) =>
        storage.sessions.compareAndSet({ ...value, revision: 2 }, 1),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { code: "CommitConflict" } });
    await Promise.allSettled([
      service.delete(thread.id),
      other.sessions.compareAndSet({ ...value, revision: 3 }, 2),
    ]);
    expect(await backend.threads.get(thread.id)).toBeNull();
    expect((await backend.sessions.get(value.id))!.selectedThreadId).toBeNull();
    await expect(
      other.sessions.compareAndSet({ ...value, revision: 20 }, 19),
    ).rejects.toMatchObject({ code: "CommitConflict" });
    expect(
      (await backend.sessions.page({ agentId: "agent", scope: value.scope }))
        .items,
    ).toHaveLength(1);
    const state = {
      ownerType: "session" as const,
      ownerId: value.id,
      pluginId: "p",
      namespace: "n",
      schemaVersion: 1,
      revision: 1,
      data: { value: 1 },
    };
    await backend.ownedState.compareAndSet(state, 0);
    await expect(
      other.ownedState.compareAndSet(state, 0),
    ).rejects.toMatchObject({ code: "CommitConflict" });
    expect(await other.ownedState.get(state)).toEqual(state);
  });

  it("rejects purged fork sources and retains referenced parents", async () => {
    const { backend, open } = await fixture(),
      other = await open(),
      service = new ThreadService(backend);
    const parent = await service.create();
    const child = await new ForkService(other).fork(parent.id);
    await service.delete(parent.id);
    await expect(backend.threads.purge(parent.id)).rejects.toMatchObject({
      code: "ThreadReferenced",
    });
    await service.delete(child.id);
    await service.purge(child.id);
    await service.purge(parent.id);
    const batch = initialBatch("late-child");
    batch.lineage = {
      parentThreadId: parent.id,
      sourceCheckpointId: parent.currentCheckpointId,
    };
    const lease = await other.ownership.acquire({
      threadId: batch.threadId,
      ownerToken: "fork",
      ttlMs: 60000,
    });
    await expect(
      new CommitCoordinator(other).commit(batch, lease),
    ).rejects.toMatchObject({ code: "ThreadNotFound" });
    expect(await backend.threads.get(batch.threadId)).toBeNull();
  });

  it("rolls back native write failures and rejects checkpoint identity reuse", async () => {
    const { backend, databaseName } = await fixture(),
      client = new MongoClient(uri!);
    const batch = initialBatch(),
      lease = await backend.ownership.acquire({
        threadId: batch.threadId,
        ownerToken: "owner",
        ttlMs: 60000,
      });
    try {
      // A real MongoDB validator fails after versions/checkpoint writes, exercising rollback.
      await client.db(databaseName).command({
        collMod: "tessar_threads",
        validator: { forbidden: { $exists: true } },
        validationLevel: "strict",
      });
      await expect(
        new CommitCoordinator(backend).commit(batch, lease),
      ).rejects.toMatchObject({ code: 121 });
      expect(await backend.checkpoints.get(batch.checkpoint.id)).toBeNull();
      expect(await backend.commits.lookupCommit(batch.commitId)).toBeNull();
      expect(await backend.threads.get(batch.threadId)).toBeNull();
      await client
        .db(databaseName)
        .command({ collMod: "tessar_threads", validator: {} });
      await new CommitCoordinator(backend).commit(batch, lease);
      const conflict = initialBatch("other");
      conflict.checkpoint.id = batch.checkpoint.id;
      const nextLease = await backend.ownership.acquire({
        threadId: "other",
        ownerToken: "owner",
        ttlMs: 60000,
      });
      await expect(
        new CommitCoordinator(backend).commit(conflict, nextLease),
      ).rejects.toMatchObject({ code: "CommitConflict" });
      expect(await backend.threads.get("other")).toBeNull();
    } finally {
      await client.close();
    }
  });

  it("stages histories larger than MongoDB's per-document limit", async () => {
    const { backend } = await fixture();
    const batch: CommitBatch = initialBatch("large");
    batch.checkpoint.state = {
      ...batch.checkpoint.state,
      messages: Array.from({ length: 18 }, () =>
        MessageCodec.encode(new HumanMessage("x".repeat(1024 * 1024))),
      ),
    };
    const lease = await backend.ownership.acquire({
      threadId: "large",
      ownerToken: "owner",
      ttlMs: 120000,
    });
    await new CommitCoordinator(backend).commit(batch, lease);
    expect(
      (await backend.checkpoints.history("large", { limit: 1 })).items,
    ).toHaveLength(1);
    expect(
      (await backend.checkpoints.get(batch.checkpoint.id))!.state.messages,
    ).toHaveLength(18);
  }, 120000);

  it("rolls back a publication when its lease expires during writes", async () => {
    const { backend } = await fixture(),
      batch = initialBatch("slow");
    await backend.commits.stage(batch);
    const lease = await backend.ownership.acquire({
      threadId: batch.threadId,
      ownerToken: "slow",
      ttlMs: 500,
    });
    const replaceOne = Collection.prototype.replaceOne;
    let reachedHeadWrite = false;
    const slow = vi
      .spyOn(Collection.prototype, "replaceOne")
      .mockImplementation(async function (this: Collection, ...args) {
        if (this.collectionName === "tessar_threads") {
          reachedHeadWrite = true;
          await delay(700);
        }
        return replaceOne.apply(this, args);
      });
    try {
      await expect(
        backend.commits.publish({
          commitId: batch.commitId,
          threadId: batch.threadId,
          expectedRevision: 0,
          lease,
        }),
      ).rejects.toMatchObject({ code: "OwnershipLost" });
      expect(reachedHeadWrite).toBe(true);
      expect(await backend.threads.get(batch.threadId)).toBeNull();
      expect(await backend.checkpoints.get(batch.checkpoint.id)).toBeNull();
      expect(await backend.commits.lookupCommit(batch.commitId)).toBeNull();
    } finally {
      slow.mockRestore();
    }
  });
});
