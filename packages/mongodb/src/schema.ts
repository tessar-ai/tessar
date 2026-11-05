import { MongoServerError, type Collection } from "mongodb";
import { fail } from "@tessar/core";
import type { Database } from "./database.js";
import type { Row } from "./queries.js";

const INVALID_CONFIGURATION = "InvalidConfiguration";

export interface StateSchema {
  threads: Collection<Row>;
  checkpoints: Collection<Row>;
  versions: Collection<Row>;
  sessions: Collection<Row>;
  owned: Collection<Row>;
  records: Collection<Row>;
  leases: Collection<Row>;
  commits: Collection<Row>;
  staging: Collection<Row>;
  pieces: Collection<Row>;
}

export async function initializeSchema({ database: db, prefix }: Database): Promise<StateSchema> {
  const hello = await db.command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid")
    fail(
      INVALID_CONFIGURATION,
      "MongoDB storage requires a replica set or sharded deployment supporting transactions",
    );
  const metadata = db.collection<{ _id: string; version: number }>(
    `${prefix}tessar_schema`,
  );
  const previous = await metadata.findOne({ _id: "schema" });
  if (previous && previous.version !== 1)
    fail(INVALID_CONFIGURATION, "Unsupported MongoDB schema version");
  const threads = db.collection<Row>(`${prefix}tessar_threads`),
    checkpoints = db.collection<Row>(`${prefix}tessar_checkpoints`),
    versions = db.collection<Row>(`${prefix}tessar_versions`),
    sessions = db.collection<Row>(`${prefix}tessar_sessions`),
    owned = db.collection<Row>(`${prefix}tessar_owned_states`),
    records = db.collection<Row>(`${prefix}tessar_records`),
    leases = db.collection<Row>(`${prefix}tessar_leases`),
    commits = db.collection<Row>(`${prefix}tessar_commits`),
    staging = db.collection<Row>(`${prefix}tessar_staging`),
    pieces = db.collection<Row>(`${prefix}tessar_staging_pieces`);
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
    fail(INVALID_CONFIGURATION, "Unsupported MongoDB schema version");
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
