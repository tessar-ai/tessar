import {
  MongoServerError,
  type Collection,
  type ClientSession,
  type Filter,
} from "mongodb";
import { fail, immutable, type Lease, type OwnershipPort } from "@tessar/core";
import type { Row } from "./queries.js";

const duration = (ttlMs: number) => {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0)
    fail("InvalidConfiguration", "Invalid lease duration");
};
const toLease = (row: Row): Lease => ({
  threadId: row._id,
  ownerToken: row.ownerToken,
  fencingToken: row.fencingToken,
  expiresAt: row.expiresAt.toISOString(),
});
const liveLease = (lease: Lease): Filter<Row> => ({
  _id: lease.threadId,
  ownerToken: lease.ownerToken,
  fencingToken: lease.fencingToken,
  $expr: { $gt: ["$expiresAt", "$$NOW"] },
});

export async function ensureThread(
  leases: Collection<Row>,
  id: string,
): Promise<void> {
  try {
    await leases.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          fencingToken: 0,
          ownerToken: "",
          expiresAt: new Date(0),
          serial: 0,
          body: "{}",
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (!(error instanceof MongoServerError && error.code === 11000))
      throw error;
  }
}
export async function touchThread(
  leases: Collection<Row>,
  id: string,
  session: ClientSession,
): Promise<void> {
  await leases.updateOne({ _id: id }, { $inc: { serial: 1 } }, { session });
}

export async function assertOwnership(
  leases: Collection<Row>,
  lease: Lease,
  session: ClientSession,
): Promise<void> {
  const result = await leases.updateOne(
    liveLease(lease),
    { $inc: { serial: 1 } },
    { session },
  );
  if (!result.matchedCount)
    fail("OwnershipLost", "Lease no longer owns thread");
}
export function createOwnership(leases: Collection<Row>): OwnershipPort {
  return {
    acquire: async (request) => {
      request = immutable(request);
      duration(request.ttlMs);
      await ensureThread(leases, request.threadId);
      const row = await leases.findOneAndUpdate(
        { _id: request.threadId, $expr: { $lte: ["$expiresAt", "$$NOW"] } },
        [
          {
            $set: {
              ownerToken: { $literal: request.ownerToken },
              fencingToken: { $add: ["$fencingToken", 1] },
              serial: { $add: ["$serial", 1] },
              expiresAt: { $add: ["$$NOW", request.ttlMs] },
            },
          },
        ],
        { returnDocument: "after" },
      );
      if (!row) fail("OwnerActive", "Thread has active owner");
      return toLease(row);
    },
    renew: async (lease, ttlMs) => {
      lease = immutable(lease);
      duration(ttlMs);
      const row = await leases.findOneAndUpdate(
        liveLease(lease),
        [
          {
            $set: {
              serial: { $add: ["$serial", 1] },
              expiresAt: { $add: ["$$NOW", ttlMs] },
            },
          },
        ],
        { returnDocument: "after" },
      );
      if (!row) fail("OwnershipLost", "Lease no longer owns thread");
      return toLease(row);
    },
    release: async (lease) => {
      lease = immutable(lease);
      await leases.updateOne(
        {
          _id: lease.threadId,
          ownerToken: lease.ownerToken,
          fencingToken: lease.fencingToken,
        },
        { $set: { expiresAt: new Date(0) }, $inc: { serial: 1 } },
      );
    },
  };
}
