import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  validateBatch,
  type Checkpoint,
  type CommitBatch,
  type ThreadInfo,
} from "@tessar/core";
import { recordTables, writeCheckpoint, writeVersions } from "./versions.js";

/** Called inside initialization's write transaction. No async work while locked. */
export function migrateV1(
  db: DatabaseSync,
  createSchema: (db: DatabaseSync) => void,
): void {
  if (Number(db.prepare("SELECT count(*) n FROM plugin_states").get()!.n))
    throw Error(
      "Migration refuses nonempty legacy plugin_states; export and reconcile custom records first",
    );
  const tables = [
    "threads",
    "checkpoints",
    "messages",
    ...recordTables,
    "plugin_states",
    "staging",
    "commits",
    "leases",
    "owned_states",
  ];
  for (const table of tables)
    db.exec(`ALTER TABLE ${table} RENAME TO _v1_${table}`);
  createSchema(db);
  for (const row of db.prepare("SELECT body FROM _v1_threads").iterate()) {
    const head = JSON.parse(String(row.body)) as ThreadInfo;
    db.prepare("INSERT INTO threads VALUES(?,?,?,?)").run(
      head.id,
      canonicalJson(head),
      head.createdAt,
      Number(head.deleted),
    );
  }
  for (const row of db
    .prepare("SELECT body FROM _v1_checkpoints ORDER BY thread_id,revision")
    .iterate()) {
    const cp = JSON.parse(String(row.body)) as Checkpoint;
    writeCheckpoint(db, cp);
    for (const kind of recordTables) {
      const entries = db
        .prepare(
          `SELECT id,body FROM _v1_${kind} WHERE thread_id=? AND checkpoint_id=?`,
        )
        .all(cp.threadId, cp.id) as { id: string; body: string }[];
      writeVersions(
        db,
        kind,
        cp.threadId,
        cp.revision,
        entries.map((entry) => ({
          id: entry.id,
          body: canonicalJson(JSON.parse(entry.body)),
        })),
        true,
      );
    }
  }
  for (const row of db.prepare("SELECT id,body FROM _v1_staging").iterate()) {
    const batch = JSON.parse(String(row.body)) as CommitBatch;
    validateBatch(batch);
    const body = canonicalJson(batch),
      fingerprint = createHash("sha256").update(body).digest("hex");
    const receipt = db
      .prepare("SELECT body FROM _v1_commits WHERE id=?")
      .get(String(row.id));
    if (receipt) {
      const value = JSON.parse(String(receipt.body));
      if (
        value.threadId !== batch.threadId ||
        value.checkpointId !== batch.checkpoint.id ||
        value.revision !== batch.checkpoint.revision
      )
        throw Error("Migration found inconsistent commit receipt");
      db.prepare("INSERT INTO commits VALUES(?,?,?,?)").run(
        String(row.id),
        canonicalJson(value),
        fingerprint,
        batch.threadId,
      );
    } else
      db.prepare("INSERT INTO staging VALUES(?,?,?)").run(
        String(row.id),
        body,
        fingerprint,
      );
  }
  if (
    db.prepare("SELECT id FROM _v1_commits EXCEPT SELECT id FROM commits").get()
  )
    throw Error(
      "Migration found a receipt without its original staged payload",
    );
  db.exec(
    "INSERT INTO leases SELECT * FROM _v1_leases; INSERT INTO owned_states SELECT * FROM _v1_owned_states;",
  );
  if (db.prepare("PRAGMA foreign_key_check").get())
    throw Error("Migration found invalid foreign keys");
  for (const table of tables.toReversed()) db.exec(`DROP TABLE _v1_${table}`);
}
