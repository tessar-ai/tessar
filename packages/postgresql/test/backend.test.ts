import { AgentHarness } from "@tessar/core/testing";
import { AssistantMessage, createTool, MessageCodec } from "@tessar/core";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  type CommitBatch,
  type SessionRecord,
  type StorageBackend,
  type PluginStateSnapshot,
  type ToolExecutionRecord,
} from "@tessar/core";
import { CommitCoordinator } from "../../core/src/state/commit.js";
import {
  initialBatch,
  storageConformance,
} from "@tessar/core/testing/storage-conformance";
import { createPostgresqlBackend } from "../src/index.js";

const connectionString = process.env.TESSAR_TEST_POSTGRES_URL;
const resources: { schema: string; backends: StorageBackend[]; admin: Pool }[] =
  [];
async function fixture() {
  const schema = "tessar_test_" + randomUUID().replaceAll("-", "");
  const resource = {
    schema,
    backends: [] as StorageBackend[],
    admin: new Pool({ connectionString, connectionTimeoutMillis: 5000 }),
  };
  resources.push(resource);
  const connect = async () => {
    const backend = await createPostgresqlBackend({
      connectionString: connectionString!,
      schema,
      driverOptions: { connectionTimeoutMillis: 5000 },
    });
    resource.backends.push(backend);
    return backend;
  };
  return { ...resource, connect, backend: await connect() };
}
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    try {
      await Promise.all(resource.backends.map((backend) => backend.close()));
      if (!/^tessar_test_[0-9a-f]{32}$/.test(resource.schema))
        throw Error("Unsafe test schema cleanup");
      await resource.admin.query(
        `DROP SCHEMA IF EXISTS "${resource.schema}" CASCADE`,
      );
    } finally {
      await resource.admin.end();
    }
  }
});
const next = (batch: CommitBatch, suffix: string): CommitBatch => ({
  ...batch,
  commitId: "commit-" + suffix,
  expectedRevision: batch.checkpoint.revision,
  checkpoint: {
    ...batch.checkpoint,
    id: "cp-" + suffix,
    parentCheckpointId: batch.checkpoint.id,
    revision: batch.checkpoint.revision + 1,
  },
});
const session = (
  id: string,
  selectedThreadId: string | null = null,
): SessionRecord => ({
  id,
  agentId: "agent",
  scope: { userId: "u" },
  metadata: {},
  selectedThreadId,
  selectedModel: { ref: { providerId: "test", modelId: "test" } },
  revision: 1,
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
});

describe.skipIf(!connectionString)(
  "PostgreSQL (requires TESSAR_TEST_POSTGRES_URL)",
  () => {
    beforeAll(async () => {
      const probe = new Pool({
        connectionString,
        connectionTimeoutMillis: 5000,
      });
      try {
        await probe.query("SELECT 1");
      } finally {
        await probe.end();
      }
    });
    storageConformance(
      "PostgreSQL storage conformance",
      async () => (await fixture()).backend,
    );
    it("adds independent records to existing schemas and retains them across connections", async () => {
      const f = await fixture();
      await f.admin.query(`DROP TABLE "${f.schema}".tessar_records`);
      const reopened = await f.connect();
      const record = await reopened.records.append({ namespace: "audit", data: { answer: "allow" } });
      const other = await f.connect();
      expect(await other.records.get("audit", record.id)).toEqual(record);
      const results = await Promise.allSettled([
        reopened.records.append({ namespace: "race", id: "one", data: 1 }),
        other.records.append({ namespace: "race", id: "one", data: 2 }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "RegistrationConflict" } });
      for (const id of ["a", "Z"])
        await other.records.append({ namespace: "ties", id, data: id });
      await f.admin.query(
        `UPDATE "${f.schema}".tessar_records SET created_at=$1,body=jsonb_set(body,'{createdAt}',to_jsonb($1::text)) WHERE namespace=$2`,
        ["2026-10-27T00:00:00.000Z", "ties"],
      );
      const first = await other.records.list({ namespace: "ties", limit: 1 });
      expect(first.items.map((row) => row.id)).toEqual(["Z"]);
      expect((await other.records.list({ namespace: "ties", limit: 1, cursor: first.nextCursor! })).items.map((row) => row.id)).toEqual(["a"]);
    });

    it("records schema version 1 and reopens existing data without resetting it", async () => {
      const f = await fixture(),
        batch = initialBatch();
      const lease = await f.backend.ownership.acquire({
        threadId: batch.threadId,
        ownerToken: "owner",
        ttlMs: 60000,
      });
      await new CommitCoordinator(f.backend).commit(batch, lease);
      expect(
        (
          await f.admin.query(
            `SELECT id,version FROM "${f.schema}".tessar_schema_metadata`,
          )
        ).rows,
      ).toEqual([{ id: "postgresql", version: 1 }]);
      await f.backend.close();
      const reopened = await f.connect();
      expect(await reopened.checkpoints.get(batch.checkpoint.id)).toEqual(
        batch.checkpoint,
      );
      expect(
        (
          await f.admin.query(
            `SELECT version FROM "${f.schema}".tessar_schema_metadata`,
          )
        ).rows,
      ).toEqual([{ version: 1 }]);
    });

    it("adopts the previously unversioned schema without changing committed data", async () => {
      const f = await fixture(),
        batch = initialBatch();
      const lease = await f.backend.ownership.acquire({
        threadId: batch.threadId,
        ownerToken: "owner",
        ttlMs: 60000,
      });
      await new CommitCoordinator(f.backend).commit(batch, lease);
      await f.backend.close();
      await f.admin.query(`DROP TABLE "${f.schema}".tessar_schema_metadata`);
      const reopened = await f.connect();
      expect(await reopened.checkpoints.get(batch.checkpoint.id)).toEqual(
        batch.checkpoint,
      );
      expect(
        (
          await f.admin.query(
            `SELECT version FROM "${f.schema}".tessar_schema_metadata`,
          )
        ).rows,
      ).toEqual([{ version: 1 }]);
      expect(await reopened.commits.lookupCommit(batch.commitId)).toMatchObject(
        { revision: 1 },
      );
    });

    it("rejects future versions before repairing indexes and preserves existing data", async () => {
      const f = await fixture(),
        batch = initialBatch();
      const lease = await f.backend.ownership.acquire({
        threadId: batch.threadId,
        ownerToken: "owner",
        ttlMs: 60000,
      });
      await new CommitCoordinator(f.backend).commit(batch, lease);
      await f.backend.close();
      await f.admin.query(
        `UPDATE "${f.schema}".tessar_schema_metadata SET version=2; DROP INDEX "${f.schema}".tessar_messages_history`,
      );
      await expect(f.connect()).rejects.toMatchObject({
        code: "InvalidConfiguration",
      });
      expect(
        (
          await f.admin.query("SELECT to_regclass($1) AS name", [
            `"${f.schema}".tessar_messages_history`,
          ])
        ).rows[0].name,
      ).toBeNull();
      expect(
        (
          await f.admin.query(
            `SELECT version FROM "${f.schema}".tessar_schema_metadata`,
          )
        ).rows,
      ).toEqual([{ version: 2 }]);
      expect(
        (
          await f.admin.query(
            `SELECT body FROM "${f.schema}".tessar_threads WHERE id=$1`,
            [batch.threadId],
          )
        ).rows[0].body.revision,
      ).toBe(1);
      await f.admin.query(`UPDATE "${f.schema}".tessar_schema_metadata SET version=1`);
      const reopened = await f.connect();
      expect(await reopened.checkpoints.get(batch.checkpoint.id)).toEqual(
        batch.checkpoint,
      );
      expect(
        (
          await f.admin.query("SELECT to_regclass($1) AS name", [
            `"${f.schema}".tessar_messages_history`,
          ])
        ).rows[0].name,
      ).not.toBeNull();
    });

    it("persists an Agent tool loop and trace records across reopening", async () => {
      const f = await fixture(),
        backend = f.backend;
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
      const restored = await f.connect();
      expect(
        (await restored.checkpoints.history(threadId!, {})).items.map(
          (message) => message.role,
        ),
      ).toEqual(["user", "assistant", "tool", "assistant"]);
    });

    it("reopens durable checkpoints and allows only one concurrently acquired owner", async () => {
      const f = await fixture(),
        second = await f.connect();
      const contenders = await Promise.allSettled(
        [f.backend, second].map((backend, i) =>
          backend.ownership.acquire({
            threadId: "t1",
            ownerToken: String(i),
            ttlMs: 60000,
          }),
        ),
      );
      expect(
        contenders.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        contenders.find((result) => result.status === "rejected"),
      ).toMatchObject({ reason: { code: "OwnerActive" } });
      const winner = contenders.find(
        (result) => result.status === "fulfilled",
      )!;
      if (winner.status !== "fulfilled") throw Error("No lease winner");
      await new CommitCoordinator(f.backend).commit(
        initialBatch(),
        winner.value,
      );
      await Promise.all([f.backend.close(), second.close()]);
      const reopened = await f.connect();
      expect(await reopened.checkpoints.get("cp-t1")).toEqual(
        initialBatch().checkpoint,
      );
      expect(await reopened.commits.lookupCommit("commit-t1")).toMatchObject({
        revision: 1,
      });
    });

    it("retains message versions without copying unchanged history and pins history cursors", async () => {
      const f = await fixture(),
        batch = initialBatch(),
        lease = await f.backend.ownership.acquire({
          threadId: "t1",
          ownerToken: "owner",
          ttlMs: 60000,
        });
      batch.checkpoint.state = {
        ...batch.checkpoint.state,
        messages: ["a", "b", "c"].map((id) => ({
          schemaVersion: 1,
          id,
          role: "user",
          content: [{ type: "text", text: id }],
        })),
      };
      const coordinator = new CommitCoordinator(f.backend);
      await coordinator.commit(batch, lease);
      const history = await f.backend.checkpoints.history("t1", { limit: 2 });
      expect(history.items.map((message) => message.id)).toEqual(["b", "c"]);
      const changed = next(batch, "changed");
      changed.checkpoint.state = {
        ...batch.checkpoint.state,
        messages: [
          batch.checkpoint.state.messages[0]!,
          {
            schemaVersion: 1,
            id: "b",
            role: "user",
            content: [{ type: "text", text: "changed" }],
          },
        ],
      };
      await coordinator.commit(changed, lease);
      await coordinator.commit(next(changed, "unchanged"), lease);
      expect(
        (await f.backend.checkpoints.get(batch.checkpoint.id))?.state.messages,
      ).toEqual(batch.checkpoint.state.messages);
      expect(
        (await f.backend.checkpoints.get(changed.checkpoint.id))?.state
          .messages,
      ).toEqual(changed.checkpoint.state.messages);
      expect(
        (
          await f.backend.checkpoints.history("t1", {
            limit: 2,
            cursor: history.nextCursor!,
          })
        ).items.map((message) => message.id),
      ).toEqual(["a"]);
      expect(
        (
          await f.admin.query(
            `SELECT count(*)::int AS n FROM "${f.schema}".tessar_messages`,
          )
        ).rows[0].n,
      ).toBe(4);
      expect(
        (
          await f.admin.query(
            `SELECT count(*)::int AS n FROM "${f.schema}".tessar_checkpoints WHERE body->'state' ? 'messages'`,
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it("filters typed scope values and pages equal-date IDs with cursor binding", async () => {
      const { backend } = await fixture();
      for (const [id, scope] of [
        ["z", { userId: "u", n: 1, flag: true }],
        ["A", { userId: "u", n: 1, flag: true }],
        ["a", { userId: "u", n: "1", flag: true }],
      ] as const) {
        const batch = initialBatch(id);
        batch.checkpoint.state = { ...batch.checkpoint.state, scope };
        const lease = await backend.ownership.acquire({
          threadId: id,
          ownerToken: id,
          ttlMs: 60000,
        });
        await new CommitCoordinator(backend).commit(batch, lease);
      }
      const first = await backend.threads.page({
        scope: { n: 1, flag: true },
        limit: 1,
      });
      expect(first.items.map((item) => item.id)).toEqual(["A"]);
      expect(
        (
          await backend.threads.page({
            scope: { n: 1, flag: true },
            cursor: first.nextCursor!,
            limit: 1,
          })
        ).items.map((item) => item.id),
      ).toEqual(["z"]);
      await expect(
        backend.threads.page({ scope: { n: "1" }, cursor: first.nextCursor! }),
      ).rejects.toMatchObject({ code: "InvalidCursor" });
    });

    it("versions execution records and queries stream/turn/status at an earlier checkpoint", async () => {
      const f = await fixture(),
        batch = initialBatch(),
        lease = await f.backend.ownership.acquire({
          threadId: "t1",
          ownerToken: "owner",
          ttlMs: 60000,
        });
      const tool = (id: string): ToolExecutionRecord => ({
        id,
        turnId: "turn",
        streamId: "stream",
        scope: { userId: "u" },
        toolCallId: id,
        parentToolExecutionId: null,
        toolName: "echo",
        arguments: {},
        policyDecision: null,
        status: "pending",
        startedAt: batch.checkpoint.createdAt,
        endedAt: null,
        durationMs: null,
        resultMessageId: null,
        result: null,
        error: null,
        idempotencyKey: null,
      });
      batch.records = ["a", "b"].map((id) => ({
        kind: "tool_executions",
        id,
        threadId: "t1",
        data: tool(id),
      }));
      const coordinator = new CommitCoordinator(f.backend);
      await coordinator.commit(batch, lease);
      const changed = next(batch, "tools");
      changed.records = [
        {
          kind: "tool_executions",
          id: "a",
          threadId: "t1",
          data: { ...tool("a"), status: "succeeded" },
        },
      ];
      await coordinator.commit(changed, lease);
      const first = await f.backend.executions.page("tool_executions", "t1", {
        atCheckpointId: batch.checkpoint.id,
        streamId: "stream",
        turnId: "turn",
        status: "pending",
        limit: 1,
      });
      expect(first.items.map((item) => item.id)).toEqual(["a"]);
      expect(
        (
          await f.backend.executions.page("tool_executions", "t1", {
            atCheckpointId: batch.checkpoint.id,
            streamId: "stream",
            turnId: "turn",
            status: "pending",
            limit: 1,
            cursor: first.nextCursor!,
          })
        ).items.map((item) => item.id),
      ).toEqual(["b"]);
      expect(
        (
          await f.backend.executions.get("tool_executions", "a", {
            atCheckpointId: batch.checkpoint.id,
          })
        )?.status,
      ).toBe("pending");
      expect(
        (
          await f.backend.executions.get("tool_executions", "a", {
            threadId: "t1",
          })
        )?.status,
      ).toBe("succeeded");
      expect(
        (
          await f.admin.query(
            `SELECT count(*)::int AS n FROM "${f.schema}".tessar_tool_executions`,
          )
        ).rows[0].n,
      ).toBe(3);
    });

    it("publishes concurrent retries once and rejects a competing stale head", async () => {
      const f = await fixture(),
        second = await f.connect(),
        batch = initialBatch();
      const lease = await f.backend.ownership.acquire({
        threadId: "t1",
        ownerToken: "owner",
        ttlMs: 60000,
      });
      const receipts = await Promise.all(
        [f.backend, second].map((backend) =>
          new CommitCoordinator(backend).commit(batch, lease),
        ),
      );
      expect(receipts[0]).toEqual(receipts[1]);
      const contenders = await Promise.allSettled([
        new CommitCoordinator(f.backend).commit(
          next(batch, "candidate-a"),
          lease,
        ),
        new CommitCoordinator(second).commit(next(batch, "candidate-b"), lease),
      ]);
      expect(
        contenders.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        contenders.find((result) => result.status === "rejected"),
      ).toMatchObject({ reason: { code: "CommitConflict" } });
      expect(
        (await f.backend.checkpoints.list("t1")).map((cp) => cp.revision),
      ).toEqual([1, 2]);
    });

    it("serializes session and owned-state CAS across connections", async () => {
      const f = await fixture(),
        second = await f.connect(),
        value = session("s");
      const sessionResults = await Promise.allSettled(
        [f.backend, second].map((backend) =>
          backend.sessions.compareAndSet(value, 0),
        ),
      );
      expect(
        sessionResults.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        sessionResults.find((result) => result.status === "rejected"),
      ).toMatchObject({ reason: { code: "CommitConflict" } });
      const state: PluginStateSnapshot = {
        ownerType: "agent",
        ownerId: "agent",
        pluginId: "plugin",
        namespace: "state",
        schemaVersion: 1,
        revision: 1,
        data: { saved: true },
      };
      const stateResults = await Promise.allSettled(
        [f.backend, second].map((backend) =>
          backend.ownedState.compareAndSet(state, 0),
        ),
      );
      expect(
        stateResults.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        stateResults.find((result) => result.status === "rejected"),
      ).toMatchObject({ reason: { code: "CommitConflict" } });
      expect(await second.ownedState.get(state)).toEqual(state);
    });

    it("clears selections atomically while a session selects a deleting thread", async () => {
      const f = await fixture(),
        second = await f.connect(),
        batch = initialBatch();
      const lease = await f.backend.ownership.acquire({
        threadId: "t1",
        ownerToken: "owner",
        ttlMs: 60000,
      });
      await new CommitCoordinator(f.backend).commit(batch, lease);
      await f.backend.sessions.compareAndSet(session("existing", "t1"), 0);
      const deletion = { ...next(batch, "delete"), deleteThread: true };
      const results = await Promise.allSettled([
        new CommitCoordinator(f.backend).commit(deletion, lease),
        second.sessions.compareAndSet(session("racing", "t1"), 0),
      ]);
      expect(results[0].status).toBe("fulfilled");
      expect(
        (await f.backend.sessions.get("existing"))?.selectedThreadId,
      ).toBeNull();
      expect(
        (await f.backend.sessions.get("racing"))?.selectedThreadId ?? null,
      ).toBeNull();
      if (results[1].status === "rejected")
        expect(results[1].reason).toMatchObject({ code: "ThreadNotFound" });
      await expect(
        second.sessions.compareAndSet(
          { ...session("existing", "t1"), revision: 2 },
          1,
        ),
      ).rejects.toMatchObject({ code: "CommitConflict" });
    });

    it("rolls back message writes on a conflicting checkpoint ID", async () => {
      const f = await fixture(),
        batch = initialBatch();
      const lease = await f.backend.ownership.acquire({
        threadId: "t1",
        ownerToken: "owner",
        ttlMs: 60000,
      });
      await new CommitCoordinator(f.backend).commit(batch, lease);
      const conflicting = next(batch, "conflict");
      conflicting.checkpoint.id = batch.checkpoint.id;
      conflicting.checkpoint.state = {
        ...batch.checkpoint.state,
        messages: [
          {
            id: "message",
            schemaVersion: 1,
            role: "user",
            content: [{ type: "text", text: "rollback" }],
          },
        ],
      };
      await expect(
        new CommitCoordinator(f.backend).commit(conflicting, lease),
      ).rejects.toMatchObject({ code: "CommitConflict" });
      expect((await f.backend.threads.get("t1"))?.revision).toBe(1);
      expect(
        await f.backend.commits.lookupCommit(conflicting.commitId),
      ).toBeNull();
      expect(
        (
          await f.admin.query(
            `SELECT count(*)::int AS n FROM "${f.schema}".tessar_messages`,
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it("uses server expiry and preserves fencing counters through purge and recreation", async () => {
      const f = await fixture(),
        batch = initialBatch();
      const old = await f.backend.ownership.acquire({
        threadId: "t1",
        ownerToken: "old",
        ttlMs: 60000,
      });
      await f.admin.query(
        `UPDATE "${f.schema}".tessar_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE thread_id=$1`,
        ["t1"],
      );
      await expect(f.backend.ownership.renew(old, 60000)).rejects.toMatchObject(
        { code: "OwnershipLost" },
      );
      const current = await f.backend.ownership.acquire({
        threadId: "t1",
        ownerToken: "new",
        ttlMs: 60000,
      });
      await expect(
        new CommitCoordinator(f.backend).commit(batch, old),
      ).rejects.toMatchObject({ code: "OwnershipLost" });
      await new CommitCoordinator(f.backend).commit(batch, current);
      await new CommitCoordinator(f.backend).commit(
        { ...next(batch, "delete"), deleteThread: true },
        current,
      );
      await expect(f.backend.threads.purge("t1")).rejects.toMatchObject({
        code: "ThreadBusy",
      });
      await f.backend.ownership.release(current);
      await f.backend.threads.purge("t1");
      const recreated = await f.backend.ownership.acquire({
        threadId: "t1",
        ownerToken: "new",
        ttlMs: 60000,
      });
      expect(recreated.fencingToken).toBeGreaterThan(current.fencingToken);
      await expect(
        f.backend.ownership.renew(current, 60000),
      ).rejects.toMatchObject({ code: "OwnershipLost" });
      await new CommitCoordinator(f.backend).commit(batch, recreated);
      expect((await f.backend.threads.get("t1"))?.revision).toBe(1);
    });

    it("protects retained fork sources and serializes fork publication against source deletion", async () => {
      const f = await fixture(),
        second = await f.connect(),
        parent = initialBatch("parent"),
        child = initialBatch("child");
      child.lineage = {
        parentThreadId: "parent",
        sourceCheckpointId: parent.checkpoint.id,
      };
      const parentLease = await f.backend.ownership.acquire({
        threadId: "parent",
        ownerToken: "p",
        ttlMs: 60000,
      });
      const childLease = await second.ownership.acquire({
        threadId: "child",
        ownerToken: "c",
        ttlMs: 60000,
      });
      await new CommitCoordinator(f.backend).commit(parent, parentLease);
      const [fork, deletion] = await Promise.allSettled([
        new CommitCoordinator(second).commit(child, childLease),
        new CommitCoordinator(f.backend).commit(
          { ...next(parent, "delete-parent"), deleteThread: true },
          parentLease,
        ),
      ]);
      expect(deletion.status).toBe("fulfilled");
      await f.backend.ownership.release(parentLease);
      if (fork.status === "fulfilled") {
        await expect(f.backend.threads.purge("parent")).rejects.toMatchObject({
          code: "ThreadReferenced",
        });
        expect(
          await second.checkpoints.get(parent.checkpoint.id),
        ).not.toBeNull();
      } else {
        expect(fork.reason).toMatchObject({ code: "ThreadNotFound" });
        await f.backend.threads.purge("parent");
        expect(await second.threads.get("child")).toBeNull();
      }
    });

    it("rolls back a publication whose lease expires while SQL is running", async () => {
      const f = await fixture();
      await f.admin.query(
        `CREATE FUNCTION "${f.schema}".slow_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$; CREATE TRIGGER slow_checkpoint BEFORE INSERT ON "${f.schema}".tessar_checkpoints FOR EACH ROW EXECUTE FUNCTION "${f.schema}".slow_checkpoint()`,
      );
      const lease = await f.backend.ownership.acquire({
        threadId: "t1",
        ownerToken: "owner",
        ttlMs: 100,
      });
      await expect(
        new CommitCoordinator(f.backend).commit(initialBatch(), lease),
      ).rejects.toMatchObject({ code: "OwnershipLost" });
      expect(await f.backend.threads.get("t1")).toBeNull();
      expect(await f.backend.checkpoints.get("cp-t1")).toBeNull();
    });
  },
);

it("rejects unsafe schema identifiers before connecting", async () => {
  await expect(
    createPostgresqlBackend({
      connectionString: "postgresql://unused",
      schema: 'x"; DROP SCHEMA public CASCADE;--',
    }),
  ).rejects.toMatchObject({ code: "InvalidConfiguration" });
});
