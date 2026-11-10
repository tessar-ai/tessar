import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { transaction, storageTransaction } from "../src/transaction.js";
import { openDatabase } from "../src/database.js";
import { createPostgresqlBackend } from "../src/index.js";

function borrowedPool() {
  const query = vi.fn().mockResolvedValue({ rows: [{ relation: null }] });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn().mockResolvedValue(client);
  const end = vi.fn();
  const pool = { connect, end } as unknown as Pool;
  return { pool, client, query, release, connect, end };
}

it("borrows and releases a client on commit and leaves the pool open after repeated close", async () => {
  const f = borrowedPool();
  const backend = await createPostgresqlBackend({ pool: f.pool });
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.query).toHaveBeenLastCalledWith("COMMIT");
  await backend.close();
  await backend.close();
  expect(f.end).not.toHaveBeenCalled();
  f.query.mockResolvedValue({ rows: [] });
  await backend.sessions.get("missing");
  expect(f.connect).toHaveBeenCalledTimes(2);
  expect(f.release).toHaveBeenCalledTimes(2);
});

it("releases a client on rollback and preserves the driver's error when rollback fails", async () => {
  const f = borrowedPool();
  const error = Error("driver failure");
  const db = openDatabase({ pool: f.pool });
  f.query.mockImplementation(async (sql: string) => {
    if (sql === "ROLLBACK") throw Error("rollback failed");
    return { rows: [] };
  });
  await expect(transaction(db, async () => {
    throw error;
  })).rejects.toBe(error);
  expect(f.query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.end).not.toHaveBeenCalled();
});

it("releases the initialization client without closing the pool on failure", async () => {
  const f = borrowedPool();
  const error = Error("initialization failed");
  f.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith("SELECT to_regclass")) throw error;
    return { rows: [] };
  });
  await expect(createPostgresqlBackend({ pool: f.pool })).rejects.toBe(error);
  expect(f.query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.end).not.toHaveBeenCalled();
});

it("preserves connection errors without ending the borrowed pool", async () => {
  const f = borrowedPool();
  const error = Error("connection failed");
  f.connect.mockRejectedValueOnce(error);
  await expect(createPostgresqlBackend({ pool: f.pool })).rejects.toBe(error);
  expect(f.release).not.toHaveBeenCalled();
  expect(f.end).not.toHaveBeenCalled();
});

it("opens a validated borrowed facade without database I/O", () => {
  const f = borrowedPool();
  const db = openDatabase({ pool: f.pool });
  expect(db.pool).toBe(f.pool);
  expect(db.schema).toBe("tessar");
  expect(db.table("threads")).toBe('"tessar"."tessar_threads"');
  expect(Object.keys(db).sort()).toEqual(["pool", "schema", "table"]);
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
  for (const pool of [null, {}, { connect: true }])
    expect(() => openDatabase({ pool: pool as never })).toThrow(expect.objectContaining({ code: "InvalidConfiguration" }));
  for (const schema of [null, 12, "", "unsafe-name"])
    expect(() => openDatabase({ pool: f.pool, schema: schema as never })).toThrow(expect.objectContaining({ code: "InvalidConfiguration" }));
});

it("uses repeatable read for reads and sorted schema-scoped locks for writes", async () => {
  const f = borrowedPool(), db = openDatabase({ pool: f.pool, schema: "custom" });
  await transaction(db, async () => 1);
  expect(f.query).toHaveBeenNthCalledWith(1, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  f.query.mockClear();
  await transaction(db, async () => 2, ["vector:z", "vector-schema", "vector:z"]);
  expect(f.query.mock.calls).toEqual([
    ["BEGIN"],
    ["SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["custom:vector-schema"]],
    ["SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["custom:vector:z"]],
    ["COMMIT"],
  ]);
});

it("maps duplicate keys only at the state boundary after releasing the client", async () => {
  const f = borrowedPool(), db = openDatabase({ pool: f.pool });
  const error = Object.assign(Error("duplicate"), { code: "23505" });
  const action = async () => { throw error; };
  await expect(transaction(db, action, [])).rejects.toBe(error);
  await expect(storageTransaction(db, action, [])).rejects.toMatchObject({ code: "CommitConflict" });
  expect(f.query.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(2);
  expect(f.release).toHaveBeenCalledTimes(2);
  expect(f.end).not.toHaveBeenCalled();
});

it.each(["BEGIN", "COMMIT"])("releases a client when %s fails", async command => {
  const f = borrowedPool(), error = Error(command);
  f.query.mockImplementation(async (sql: string) => {
    if (sql === command) throw error;
    return { rows: [] };
  });
  await expect(transaction(openDatabase({ pool: f.pool }), async () => 1, [])).rejects.toBe(error);
  expect(f.query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.end).not.toHaveBeenCalled();
});

it("maps duplicate state writes through backend callers and releases the client", async () => {
  const f = borrowedPool();
  const backend = await createPostgresqlBackend({ pool: f.pool });
  const error = Object.assign(Error("duplicate"), { code: "23505" });
  f.query.mockImplementation(async (sql: string) => {
    if (sql.includes("INSERT INTO")) throw error;
    return { rows: [] };
  });
  await expect(backend.ownedState.compareAndSet({
    ownerType: "agent", ownerId: "agent", pluginId: "plugin", namespace: "test", revision: 1, schemaVersion: 1, data: {},
  }, 0)).rejects.toMatchObject({ code: "CommitConflict" });
  expect(f.query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(f.release).toHaveBeenCalledTimes(2);
  expect(f.end).not.toHaveBeenCalled();
});
