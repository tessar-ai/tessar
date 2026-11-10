import { describe, expect, it, vi } from "vitest";
import { MongoServerError, type Db } from "mongodb";
import { createMongoDBBackend } from "../src/index.js";
import { openDatabase } from "../src/database.js";
import { transaction } from "../src/transaction.js";

function database() {
  const rows = new Map<string, Map<string, any>>();
  const collections = new Map<string, any>();
  const session = {
    withTransaction: vi.fn(async (action: () => Promise<unknown>) => action()),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const client = {
    startSession: vi.fn(() => session),
    connect: vi.fn(),
    close: vi.fn(),
  };
  const db = {
    client,
    command: vi.fn().mockResolvedValue({ setName: "replica" }),
    createCollection: vi.fn().mockResolvedValue(undefined),
    collection: vi.fn((name: string) => {
      if (!collections.has(name)) {
        const data = new Map<string, any>();
        rows.set(name, data);
        collections.set(name, {
          collectionName: name,
          createIndex: vi.fn().mockResolvedValue(undefined),
          findOne: vi.fn(async ({ _id }: { _id: string }) => data.get(_id) ?? null),
          updateOne: vi.fn(async ({ _id }: { _id: string }, update: any) => {
            if (!data.has(_id)) data.set(_id, { _id, ...update.$setOnInsert });
          }),
        });
      }
      return collections.get(name);
    }),
  };
  return { db: db as unknown as Db, client, session, rows, collections };
}

describe("borrowed MongoDB database", () => {
  it("opens a synchronous facade without database I/O", () => {
    const { db, client } = database();
    expect(openDatabase({ database: db, namespace: "agent" })).toEqual({ database: db, prefix: "agent_" });
    expect(db.command).not.toHaveBeenCalled();
    expect(db.collection).not.toHaveBeenCalled();
    expect(db.createCollection).not.toHaveBeenCalled();
    expect(client.startSession).not.toHaveBeenCalled();
  });

  it("preserves native duplicate errors while state maps them after cleanup", async () => {
    const { db, session, collections } = database();
    const backend = await createMongoDBBackend({ database: db });
    const duplicate = new MongoServerError({ message: "duplicate", code: 11000 });
    session.endSession.mockRejectedValue(new Error("cleanup"));
    await expect(transaction(openDatabase({ database: db }), async () => { throw duplicate; })).rejects.toBe(duplicate);
    collections.get("tessar_checkpoints").findOne.mockRejectedValueOnce(duplicate);
    await expect(backend.checkpoints.get("missing")).rejects.toMatchObject({ code: "CommitConflict" });
    expect(session.endSession).toHaveBeenCalledTimes(2);
  });

  it("reports cleanup failure after successful work and preserves other failures", async () => {
    const { db, session } = database();
    const facade = openDatabase({ database: db });
    const cleanup = new Error("cleanup"), original = new Error("read failed");
    session.endSession.mockRejectedValue(cleanup);
    await expect(transaction(facade, async () => 1)).rejects.toBe(cleanup);
    await expect(transaction(facade, async () => { throw original; })).rejects.toBe(original);
  });

  it("uses the supplied database and namespaces every collection including metadata", async () => {
    const { db, client, collections, rows } = database();
    const first = await createMongoDBBackend({ database: db });
    const second = await createMongoDBBackend({ database: db, namespace: "agent_state" });
    rows.get("tessar_threads")!.set("thread", { body: JSON.stringify({ id: "default" }) });
    rows.get("agent_state_tessar_threads")!.set("thread", { body: JSON.stringify({ id: "namespaced" }) });
    expect(await first.threads.get("thread")).toEqual({ id: "default" });
    expect(await second.threads.get("thread")).toEqual({ id: "namespaced" });
    const names = [...collections.keys()];
    const defaults = names.filter((name) => name.startsWith("tessar_"));
    expect(defaults).toHaveLength(11);
    expect(names.filter((name) => name.startsWith("agent_state_"))).toEqual(
      defaults.map((name) => `agent_state_${name}`),
    );
    rows.get("tessar_schema")!.set("schema", { version: 99 });
    await expect(createMongoDBBackend({ database: db })).rejects.toMatchObject({ code: "InvalidConfiguration" });
    await expect(createMongoDBBackend({ database: db, namespace: "agent_state" })).resolves.toBeDefined();
    await first.close();
    await first.close();
    await second.close();
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  });

  it.each(["", "with-dash", "a.b", "a$b", "a b", "é", "1first", "a".repeat(64)])(
    "rejects invalid namespace %j before accessing the database", async (namespace) => {
      const { db } = database();
      await expect(createMongoDBBackend({ database: db, namespace })).rejects.toMatchObject({ code: "InvalidConfiguration" });
      expect(db.command).not.toHaveBeenCalled();
      expect(db.collection).not.toHaveBeenCalled();
    },
  );

  it("retains the client and original driver error when initialization fails", async () => {
    const { db, client } = database();
    const error = new MongoServerError({ message: "denied", code: 13 });
    vi.mocked(db.command).mockRejectedValueOnce(error);
    await expect(createMongoDBBackend({ database: db })).rejects.toBe(error);
    expect(client.close).not.toHaveBeenCalled();
  });

  it.each(["_", "a".repeat(63)])("accepts boundary namespace %j", async (namespace) => {
    const { db } = database();
    await expect(createMongoDBBackend({ database: db, namespace })).resolves.toBeDefined();
  });

  it("does not modify application collections", async () => {
    const { db, rows } = database();
    const application = db.collection("application");
    rows.get("application")!.set("settings", { theme: "dark" });
    await createMongoDBBackend({ database: db, namespace: "agent_state" });
    expect(rows.get("application")!.get("settings")).toEqual({ theme: "dark" });
    expect(application.createIndex).not.toHaveBeenCalled();
  });

  it("leaves the client open after collection creation fails", async () => {
    const { db, client } = database();
    const error = new MongoServerError({ message: "create denied", code: 13 });
    vi.mocked(db.createCollection).mockRejectedValueOnce(error);
    await expect(createMongoDBBackend({ database: db })).rejects.toBe(error);
    expect(client.close).not.toHaveBeenCalled();
  });

  it("ends its transaction sessions on success and failure without closing the client", async () => {
    const { db, client, session, collections } = database();
    const backend = await createMongoDBBackend({ database: db });
    expect(await backend.checkpoints.get("missing")).toBeNull();
    expect(client.startSession).toHaveBeenCalledOnce();
    expect(session.endSession).toHaveBeenCalledOnce();
    const error = new MongoServerError({ message: "read failed", code: 13 });
    collections.get("tessar_checkpoints").findOne.mockRejectedValueOnce(error);
    await expect(backend.checkpoints.get("missing")).rejects.toBe(error);
    expect(session.endSession).toHaveBeenCalledTimes(2);
    await backend.close();
    expect(client.close).not.toHaveBeenCalled();
  });
});
