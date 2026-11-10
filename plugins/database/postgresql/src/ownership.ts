import { storageTransaction } from "./transaction.js";
import type { PoolClient } from "pg";
import { fail, immutable, type Lease, type OwnershipPort } from "@tessar/core";
import type { Database } from "./database.js";

export async function assertOwnership(
  db: Database,
  client: PoolClient,
  lease: Lease,
): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM ${db.table("leases")} WHERE thread_id=$1 AND owner_token=$2 AND fencing_token=$3 AND expires_at>clock_timestamp()`,
    [lease.threadId, lease.ownerToken, lease.fencingToken],
  );
  if (!result.rowCount) fail("OwnershipLost", "Lease no longer owns thread");
}

export function createOwnership(db: Database): OwnershipPort {
  const table = db.table;
  const toLease = (row: any): Lease => ({
    threadId: row.thread_id,
    ownerToken: row.owner_token,
    fencingToken: Number(row.fencing_token),
    expiresAt: row.expires_at.toISOString(),
  });
  const validTtl = (ttl: number) => {
    if (!Number.isFinite(ttl) || ttl <= 0)
      fail("InvalidConfiguration", "Invalid lease duration");
  };
  return {
    acquire: async (request) => {
      request = immutable(request);
      return storageTransaction(db,
        async (client) => {
          validTtl(request.ttlMs);
          const { rows } = await client.query(
            `INSERT INTO ${table("leases")}(thread_id,owner_token,fencing_token,expires_at) VALUES($1,$2,1,clock_timestamp()+$3::double precision*interval '1 millisecond') ON CONFLICT(thread_id) DO UPDATE SET owner_token=excluded.owner_token,fencing_token=${table("leases")}.fencing_token+1,expires_at=clock_timestamp()+$3::double precision*interval '1 millisecond' WHERE ${table("leases")}.expires_at<=clock_timestamp() RETURNING *`,
            [request.threadId, request.ownerToken, request.ttlMs],
          );
          if (!rows[0]) fail("OwnerActive", "Thread has active owner");
          return toLease(rows[0]);
        },
        ["thread:" + request.threadId],
      );
    },
    renew: async (lease, ttlMs) => {
      lease = immutable(lease);
      return storageTransaction(db,
        async (client) => {
          validTtl(ttlMs);
          const { rows } = await client.query(
            `UPDATE ${table("leases")} SET expires_at=clock_timestamp()+$4::double precision*interval '1 millisecond' WHERE thread_id=$1 AND owner_token=$2 AND fencing_token=$3 AND expires_at>clock_timestamp() RETURNING *`,
            [lease.threadId, lease.ownerToken, lease.fencingToken, ttlMs],
          );
          if (!rows[0]) fail("OwnershipLost", "Lease no longer owns thread");
          return toLease(rows[0]);
        },
        ["thread:" + lease.threadId],
      );
    },
    release: async (lease) => {
      lease = immutable(lease);
      return storageTransaction(db,
        async (client) => {
          await client.query(
            `UPDATE ${table("leases")} SET expires_at='epoch' WHERE thread_id=$1 AND owner_token=$2 AND fencing_token=$3`,
            [lease.threadId, lease.ownerToken, lease.fencingToken],
          );
        },
        ["thread:" + lease.threadId],
      );
    },
  };
}
