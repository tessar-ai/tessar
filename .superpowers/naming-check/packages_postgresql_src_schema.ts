import { fail } from "@tessar/core";
import type { Database } from "./database.js";
export const recordTables = [
  "streams",
  "turns",
  "model_attempts",
  "tool_executions",
  "interrupts",
] as const;

export async function initializeSchema(db: Database): Promise<void> {
  const { table, schema } = db;
  await db.transaction(
    async (client) => {
      // Reject future versions before touching application tables or indexes.
      const metadata = await client.query(
        "SELECT to_regclass($1) AS relation",
        [table("schema_metadata")],
      );
      if (metadata.rows[0].relation) {
        const { rows } = await client.query(
          `SELECT id,version FROM ${table("schema_metadata")}`,
        );
        if (
          rows.length !== 1 ||
          rows[0].id !== "postgresql" ||
          rows[0].version !== 1
        )
          fail("InvalidConfiguration", "Unsupported PostgreSQL schema version");
      }
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      await client.query(`
    CREATE TABLE IF NOT EXISTS ${table("threads")}(id TEXT PRIMARY KEY,body JSONB NOT NULL,created_at TEXT COLLATE "C" NOT NULL,deleted BOOLEAN NOT NULL);
    CREATE TABLE IF NOT EXISTS ${table("checkpoints")}(id TEXT COLLATE "C" PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES ${table("threads")}(id) DEFERRABLE INITIALLY DEFERRED,revision INTEGER NOT NULL,created_at TEXT COLLATE "C" NOT NULL,cause TEXT NOT NULL,message_count INTEGER NOT NULL,forkable BOOLEAN NOT NULL,unsafe_reason TEXT,body JSONB NOT NULL,UNIQUE(thread_id,revision));
    CREATE INDEX IF NOT EXISTS checkpoints_page ON ${table("checkpoints")}(thread_id,created_at,id);
    CREATE INDEX IF NOT EXISTS threads_page ON ${table("threads")}(deleted,created_at,id COLLATE "C");
    CREATE INDEX IF NOT EXISTS threads_parent ON ${table("threads")}((body->>'parentThreadId'));
    CREATE INDEX IF NOT EXISTS threads_source ON ${table("threads")}((body->>'sourceCheckpointId'));
    CREATE TABLE IF NOT EXISTS ${table("staging")}(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,body JSONB NOT NULL,fingerprint TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS staging_thread ON ${table("staging")}(thread_id);
    CREATE TABLE IF NOT EXISTS ${table("commits")}(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES ${table("threads")}(id),body JSONB NOT NULL,fingerprint TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS commits_thread ON ${table("commits")}(thread_id);
    CREATE TABLE IF NOT EXISTS ${table("leases")}(thread_id TEXT PRIMARY KEY,owner_token TEXT NOT NULL,fencing_token BIGINT NOT NULL,expires_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS ${table("owned_states")}(owner_key TEXT PRIMARY KEY,revision INTEGER NOT NULL,body JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS ${table("sessions")}(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,selected_thread_id TEXT REFERENCES ${table("threads")}(id),revision INTEGER NOT NULL,created_at TEXT COLLATE "C" NOT NULL,updated_at TEXT NOT NULL,body JSONB NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_page ON ${table("sessions")}(agent_id,created_at,id COLLATE "C");
    CREATE INDEX IF NOT EXISTS sessions_thread ON ${table("sessions")}(selected_thread_id);
  `);
      for (const name of ["messages", ...recordTables])
        await client.query(`
    CREATE TABLE IF NOT EXISTS ${table(name)}(thread_id TEXT NOT NULL REFERENCES ${table("threads")}(id) DEFERRABLE INITIALLY DEFERRED,id TEXT COLLATE "C" NOT NULL,from_revision INTEGER NOT NULL,to_revision INTEGER,position INTEGER,stream_id TEXT,turn_id TEXT,status TEXT,sort_date TEXT COLLATE "C" NOT NULL,body JSONB NOT NULL,PRIMARY KEY(thread_id,id,from_revision),CHECK(to_revision IS NULL OR to_revision>from_revision));
    CREATE UNIQUE INDEX IF NOT EXISTS ${name}_current ON ${table(name)}(thread_id,id) WHERE to_revision IS NULL;
    CREATE INDEX IF NOT EXISTS ${name}_page ON ${table(name)}(thread_id,sort_date,id,from_revision);
    CREATE INDEX IF NOT EXISTS ${name}_stream ON ${table(name)}(thread_id,stream_id,sort_date,id);
    CREATE INDEX IF NOT EXISTS ${name}_turn ON ${table(name)}(thread_id,turn_id,sort_date,id);
  `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS messages_history ON ${table("messages")}(thread_id,position,from_revision)`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${table("schema_metadata")}(id TEXT PRIMARY KEY CHECK(id='postgresql'),version INTEGER NOT NULL)`,
      );
      await client.query(
        `INSERT INTO ${table("schema_metadata")}(id,version) VALUES('postgresql',1) ON CONFLICT(id) DO NOTHING`,
      );
    },
    ["initialize"],
  );
}
