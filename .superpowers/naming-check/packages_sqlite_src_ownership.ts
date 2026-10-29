import type { DatabaseSync } from "node:sqlite";
import { fail, type Lease, type OwnershipPort } from "@tessar/core";
type LeaseRow = {
  thread_id: string;
  owner_token: string;
  fencing_token: number;
  expires_at: number;
};
export function databaseNow(db: DatabaseSync): number {
  return (
    db
      .prepare(
        "SELECT CAST((julianday('now') - 2440587.5)*86400000 AS INTEGER) AS now",
      )
      .get() as { now: number }
  ).now;
}
export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function assertOwnership(db: DatabaseSync, lease: Lease): void {
  const row = db
    .prepare("SELECT * FROM leases WHERE thread_id=?")
    .get(lease.threadId) as LeaseRow | undefined;
  if (
    !row ||
    row.owner_token !== lease.ownerToken ||
    row.fencing_token !== lease.fencingToken ||
    row.expires_at <= databaseNow(db)
  )
    fail("OwnershipLost", "Lease no longer owns thread");
}
const toLease = (row: LeaseRow): Lease => ({
  threadId: row.thread_id,
  ownerToken: row.owner_token,
  fencingToken: row.fencing_token,
  expiresAt: new Date(row.expires_at).toISOString(),
});
export function createOwnership(db: DatabaseSync): OwnershipPort {
  return {
    acquire: async (request) =>
      transaction(db, () => {
        if (!Number.isFinite(request.ttlMs) || request.ttlMs <= 0)
          fail("InvalidConfiguration", "Invalid lease duration");
        const previous = db
            .prepare("SELECT * FROM leases WHERE thread_id=?")
            .get(request.threadId) as LeaseRow | undefined,
          now = databaseNow(db);
        if (previous && previous.expires_at > now)
          fail("OwnerActive", "Thread has active owner");
        const row = {
          thread_id: request.threadId,
          owner_token: request.ownerToken,
          fencing_token: (previous?.fencing_token ?? 0) + 1,
          expires_at: now + request.ttlMs,
        };
        db.prepare(
          "INSERT INTO leases VALUES(?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET owner_token=excluded.owner_token,fencing_token=excluded.fencing_token,expires_at=excluded.expires_at",
        ).run(
          row.thread_id,
          row.owner_token,
          row.fencing_token,
          row.expires_at,
        );
        return toLease(row);
      }),
    renew: async (lease, ttlMs) =>
      transaction(db, () => {
        assertOwnership(db, lease);
        if (!Number.isFinite(ttlMs) || ttlMs <= 0)
          fail("InvalidConfiguration", "Invalid lease duration");
        const expires = databaseNow(db) + ttlMs;
        db.prepare("UPDATE leases SET expires_at=? WHERE thread_id=?").run(
          expires,
          lease.threadId,
        );
        return { ...lease, expiresAt: new Date(expires).toISOString() };
      }),
    release: async (lease) => {
      db.prepare(
        "UPDATE leases SET expires_at=0 WHERE thread_id=? AND owner_token=? AND fencing_token=?",
      ).run(lease.threadId, lease.ownerToken, lease.fencingToken);
    },
  };
}
