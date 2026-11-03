import type { Database } from "./database.js";
import { transaction } from "./transaction.js";
import { fail } from "@tessar/core";
import { recordTables } from "./versions.js";
export { recordTables };
export async function initializeSchema(db: Database): Promise<void> {
  transaction(db, () => createSchema(db));
}

export function createSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${db.prefix}tessar_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)`);
  const saved = db.prepare(`SELECT version FROM ${db.prefix}tessar_schema WHERE id=1`).get() as { version: number } | undefined;
  if (saved && saved.version !== 1) fail("InvalidConfiguration", "Unsupported libSQL schema version");
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${db.prefix}tessar_threads(id TEXT PRIMARY KEY,body TEXT NOT NULL,created_at TEXT NOT NULL,deleted INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ${db.prefix}tessar_checkpoints(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES ${db.prefix}tessar_threads(id) DEFERRABLE INITIALLY DEFERRED,revision INTEGER NOT NULL,created_at TEXT NOT NULL,cause TEXT NOT NULL,message_count INTEGER NOT NULL,forkable INTEGER NOT NULL,unsafe_reason TEXT,body TEXT NOT NULL,UNIQUE(thread_id,revision));
    CREATE INDEX IF NOT EXISTS ${db.prefix}tessar_checkpoints_page ON ${db.prefix}tessar_checkpoints(thread_id,created_at,id);
    CREATE INDEX IF NOT EXISTS ${db.prefix}tessar_threads_page ON ${db.prefix}tessar_threads(deleted,created_at,id);
    CREATE TABLE IF NOT EXISTS ${db.prefix}tessar_staging(id TEXT PRIMARY KEY,body TEXT NOT NULL,fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ${db.prefix}tessar_commits(id TEXT PRIMARY KEY,body TEXT NOT NULL,fingerprint TEXT NOT NULL,thread_id TEXT NOT NULL REFERENCES ${db.prefix}tessar_threads(id));
    CREATE INDEX IF NOT EXISTS ${db.prefix}tessar_commits_thread ON ${db.prefix}tessar_commits(thread_id);
    CREATE TABLE IF NOT EXISTS ${db.prefix}tessar_leases(thread_id TEXT PRIMARY KEY,owner_token TEXT NOT NULL,fencing_token INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ${db.prefix}tessar_owned_states(owner_key TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ${db.prefix}tessar_records(namespace TEXT NOT NULL,id TEXT NOT NULL,created_at TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(namespace,id));
    CREATE INDEX IF NOT EXISTS ${db.prefix}tessar_records_page ON ${db.prefix}tessar_records(namespace,created_at,id);
    CREATE TABLE IF NOT EXISTS ${db.prefix}tessar_sessions(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,selected_thread_id TEXT REFERENCES ${db.prefix}tessar_threads(id),revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ${db.prefix}tessar_sessions_page ON ${db.prefix}tessar_sessions(agent_id,created_at,id);
    CREATE INDEX IF NOT EXISTS ${db.prefix}tessar_sessions_thread ON ${db.prefix}tessar_sessions(selected_thread_id);
  `);
  for (const table of ["messages", ...recordTables]) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${db.prefix}tessar_${table}(
      thread_id TEXT NOT NULL REFERENCES ${db.prefix}tessar_threads(id) DEFERRABLE INITIALLY DEFERRED,id TEXT NOT NULL,
      from_revision INTEGER NOT NULL,to_revision INTEGER,position INTEGER,stream_id TEXT,turn_id TEXT,status TEXT,sort_date TEXT NOT NULL,body TEXT NOT NULL,
      PRIMARY KEY(thread_id,id,from_revision), CHECK(to_revision IS NULL OR to_revision>from_revision));
      CREATE UNIQUE INDEX IF NOT EXISTS ${db.prefix}tessar_${table}_current ON ${db.prefix}tessar_${table}(thread_id,id) WHERE to_revision IS NULL;
      CREATE INDEX IF NOT EXISTS ${db.prefix}tessar_${table}_page ON ${db.prefix}tessar_${table}(thread_id,sort_date,id,from_revision);
      CREATE INDEX IF NOT EXISTS ${db.prefix}tessar_${table}_stream ON ${db.prefix}tessar_${table}(thread_id,stream_id,sort_date,id);
      CREATE INDEX IF NOT EXISTS ${db.prefix}tessar_${table}_turn ON ${db.prefix}tessar_${table}(thread_id,turn_id,sort_date,id);
    `);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${db.prefix}tessar_messages_history ON ${db.prefix}tessar_messages(thread_id,position,from_revision)`,
  );
  db.prepare(`INSERT INTO ${db.prefix}tessar_schema(id,version) VALUES(1,1) ON CONFLICT(id) DO NOTHING`).run();
}
