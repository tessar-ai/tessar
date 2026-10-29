import type { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import { migrateV1 } from "./migration.js";
import { recordTables } from "./versions.js";
import { fail } from "@tessar/core";
export { recordTables };
export async function initializeSchema(db: DatabaseSync): Promise<void> {
  db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode=WAL;");
      break;
    } catch (error) {
      // SQLite can return BUSY immediately while concurrent connections enable WAL.
      if (
        ![5, 6].includes((error as { errcode?: number }).errcode ?? 0) ||
        Date.now() >= deadline
      )
        throw error;
      await setTimeout(10);
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = Number(
      db.prepare("PRAGMA user_version").get()!.user_version,
    );
    if (![0, 1, 2].includes(version))
      fail("InvalidConfiguration", "Unsupported SQLite schema version");
    if (version === 1) migrateV1(db, createSchema);
    else createSchema(db);
    db.exec("PRAGMA user_version=2; COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,body TEXT NOT NULL,created_at TEXT NOT NULL,deleted INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id) DEFERRABLE INITIALLY DEFERRED,revision INTEGER NOT NULL,created_at TEXT NOT NULL,cause TEXT NOT NULL,message_count INTEGER NOT NULL,forkable INTEGER NOT NULL,unsafe_reason TEXT,body TEXT NOT NULL,UNIQUE(thread_id,revision));
    CREATE INDEX IF NOT EXISTS checkpoints_page ON checkpoints(thread_id,created_at,id);
    CREATE INDEX IF NOT EXISTS threads_page ON threads(deleted,created_at,id);
    CREATE TABLE IF NOT EXISTS staging(id TEXT PRIMARY KEY,body TEXT NOT NULL,fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commits(id TEXT PRIMARY KEY,body TEXT NOT NULL,fingerprint TEXT NOT NULL,thread_id TEXT NOT NULL REFERENCES threads(id));
    CREATE INDEX IF NOT EXISTS commits_thread ON commits(thread_id);
    CREATE TABLE IF NOT EXISTS leases(thread_id TEXT PRIMARY KEY,owner_token TEXT NOT NULL,fencing_token INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS owned_states(owner_key TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,selected_thread_id TEXT REFERENCES threads(id),revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_page ON sessions(agent_id,created_at,id);
    CREATE INDEX IF NOT EXISTS sessions_thread ON sessions(selected_thread_id);
  `);
  for (const table of ["messages", ...recordTables]) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table}(
      thread_id TEXT NOT NULL REFERENCES threads(id) DEFERRABLE INITIALLY DEFERRED,id TEXT NOT NULL,
      from_revision INTEGER NOT NULL,to_revision INTEGER,position INTEGER,stream_id TEXT,turn_id TEXT,status TEXT,sort_date TEXT NOT NULL,body TEXT NOT NULL,
      PRIMARY KEY(thread_id,id,from_revision), CHECK(to_revision IS NULL OR to_revision>from_revision));
      CREATE UNIQUE INDEX IF NOT EXISTS ${table}_current ON ${table}(thread_id,id) WHERE to_revision IS NULL;
      CREATE INDEX IF NOT EXISTS ${table}_page ON ${table}(thread_id,sort_date,id,from_revision);
      CREATE INDEX IF NOT EXISTS ${table}_stream ON ${table}(thread_id,stream_id,sort_date,id);
      CREATE INDEX IF NOT EXISTS ${table}_turn ON ${table}(thread_id,turn_id,sort_date,id);
    `);
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS messages_history ON messages(thread_id,position,from_revision)",
  );
}
