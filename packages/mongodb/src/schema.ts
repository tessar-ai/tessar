import { MongoServerError, type Db } from "mongodb";
import { fail } from "@tessar/core";
import type { Row } from "./queries.js";

export async function initializeSchema(db: Db) {
  const hello = await db.command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid")
    fail(
      "InvalidConfiguration",
      "MongoDB storage requires a replica set or sharded deployment supporting transactions",
    );
  const metadata = db.collection<{ _id: string; version: number }>(
    "tessar_schema",
  );
  const previous = await metadata.findOne({ _id: "schema" });
  if (previous && previous.version !== 1)
    fail("InvalidConfiguration", "Unsupported MongoDB schema version");
  const threads = db.collection<Row>("tessar_threads"),
    checkpoints = db.collection<Row>("tessar_checkpoints"),
    versions = db.collection<Row>("tessar_versions"),
    sessions = db.collection<Row>("tessar_sessions"),
    owned = db.collection<Row>("tessar_owned_states"),
    records = db.collection<Row>("tessar_records"),
    leases = db.collection<Row>("tessar_leases"),
    commits = db.collection<Row>("tessar_commits"),
    staging = db.collection<Row>("tessar_staging"),
    pieces = db.collection<Row>("tessar_staging_pieces");
  // Create every collection before entering transactions (including otherwise unindexed ones).
  for (const collection of [
    threads,
    checkpoints,
    versions,
    sessions,
    owned,
    records,
    leases,
    commits,
    staging,
    pieces,
  ]) {
    try {
      await db.createCollection(collection.collectionName);
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 48))
        throw error;
    }
  }
  await threads.createIndex({ deleted: 1, sortDate: 1, id: 1 });
  await threads.createIndex({
    scopeTokens: 1,
    deleted: 1,
    sortDate: 1,
    id: 1,
  });
  await threads.createIndex({ parentThreadId: 1 });
  await threads.createIndex({ sourceCheckpointId: 1 });
  await checkpoints.createIndex({ threadId: 1, revision: 1 }, { unique: true });
  await checkpoints.createIndex({ threadId: 1, sortDate: 1, id: 1 });
  await versions.createIndex(
    { threadId: 1, kind: 1, id: 1, fromRevision: 1 },
    { unique: true },
  );
  await versions.createIndex({
    threadId: 1,
    kind: 1,
    toRevision: 1,
    position: 1,
  });
  await versions.createIndex({ threadId: 1, kind: 1, sortDate: 1, id: 1 });
  await versions.createIndex({ kind: 1, id: 1, toRevision: 1 });
  await sessions.createIndex({
    agentId: 1,
    scopeTokens: 1,
    sortDate: 1,
    id: 1,
  });
  await sessions.createIndex({ selectedThreadId: 1 });
  await records.createIndex({ namespace: 1, sortDate: 1, id: 1 });
  await records.createIndex({
    namespace: 1,
    scopeTokens: 1,
    sortDate: 1,
    id: 1,
  });
  await commits.createIndex({ threadId: 1 });
  await staging.createIndex({ threadId: 1 });
  await pieces.createIndex({ commitId: 1, kind: 1, position: 1 });
  await pieces.createIndex({ threadId: 1 });
  await metadata.updateOne(
    { _id: "schema" },
    { $setOnInsert: { version: 1 } },
    { upsert: true },
  );
  const current = await metadata.findOne({ _id: "schema" });
  if (current?.version !== 1)
    fail("InvalidConfiguration", "Unsupported MongoDB schema version");
  return {
    threads,
    checkpoints,
    versions,
    sessions,
    owned,
    records,
    leases,
    commits,
    staging,
    pieces,
  };
}
