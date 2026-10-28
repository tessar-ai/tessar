import type { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import { recordTables } from "./versions.js";
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
    createSchema(db);
    db.exec("PRAGMA user_version=1; COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tessar_threads(id TEXT PRIMARY KEY,body TEXT NOT NULL,created_at TEXT NOT NULL,deleted INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tessar_checkpoints(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES tessar_threads(id) DEFERRABLE INITIALLY DEFERRED,revision INTEGER NOT NULL,created_at TEXT NOT NULL,cause TEXT NOT NULL,message_count INTEGER NOT NULL,forkable INTEGER NOT NULL,unsafe_reason TEXT,body TEXT NOT NULL,UNIQUE(thread_id,revision));
    CREATE INDEX IF NOT EXISTS tessar_checkpoints_page ON tessar_checkpoints(thread_id,created_at,id);
    CREATE INDEX IF NOT EXISTS tessar_threads_page ON tessar_threads(deleted,created_at,id);
    CREATE TABLE IF NOT EXISTS tessar_staging(id TEXT PRIMARY KEY,body TEXT NOT NULL,fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tessar_commits(id TEXT PRIMARY KEY,body TEXT NOT NULL,fingerprint TEXT NOT NULL,thread_id TEXT NOT NULL REFERENCES tessar_threads(id));
    CREATE INDEX IF NOT EXISTS tessar_commits_thread ON tessar_commits(thread_id);
    CREATE TABLE IF NOT EXISTS tessar_leases(thread_id TEXT PRIMARY KEY,owner_token TEXT NOT NULL,fencing_token INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tessar_owned_states(owner_key TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tessar_records(namespace TEXT NOT NULL,id TEXT NOT NULL,created_at TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(namespace,id));
    CREATE INDEX IF NOT EXISTS tessar_records_page ON tessar_records(namespace,created_at,id);
    CREATE TABLE IF NOT EXISTS tessar_sessions(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,selected_thread_id TEXT REFERENCES tessar_threads(id),revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS tessar_sessions_page ON tessar_sessions(agent_id,created_at,id);
    CREATE INDEX IF NOT EXISTS tessar_sessions_thread ON tessar_sessions(selected_thread_id);
  `);
  for (const table of ["messages", ...recordTables]) {
    db.exec(`CREATE TABLE IF NOT EXISTS tessar_${table}(
      thread_id TEXT NOT NULL REFERENCES tessar_threads(id) DEFERRABLE INITIALLY DEFERRED,id TEXT NOT NULL,
      from_revision INTEGER NOT NULL,to_revision INTEGER,position INTEGER,stream_id TEXT,turn_id TEXT,status TEXT,sort_date TEXT NOT NULL,body TEXT NOT NULL,
      PRIMARY KEY(thread_id,id,from_revision), CHECK(to_revision IS NULL OR to_revision>from_revision));
      CREATE UNIQUE INDEX IF NOT EXISTS tessar_${table}_current ON tessar_${table}(thread_id,id) WHERE to_revision IS NULL;
      CREATE INDEX IF NOT EXISTS tessar_${table}_page ON tessar_${table}(thread_id,sort_date,id,from_revision);
      CREATE INDEX IF NOT EXISTS tessar_${table}_stream ON tessar_${table}(thread_id,stream_id,sort_date,id);
      CREATE INDEX IF NOT EXISTS tessar_${table}_turn ON tessar_${table}(thread_id,turn_id,sort_date,id);
    `);
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS tessar_messages_history ON tessar_messages(thread_id,position,from_revision)",
  );
}
