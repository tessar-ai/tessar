import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeSchema } from "../src/schema.js";

it("initializes the current schema as v1 with tessar_ tables and indexes", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    await initializeSchema(db);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    expect(tables.map(row => row.name)).toEqual([
      "tessar_checkpoints",
      "tessar_commits",
      "tessar_interrupts",
      "tessar_leases",
      "tessar_messages",
      "tessar_model_attempts",
      "tessar_owned_states",
      "tessar_records",
      "tessar_sessions",
      "tessar_staging",
      "tessar_streams",
      "tessar_threads",
      "tessar_tool_executions",
      "tessar_turns",
    ]);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
      .all();
    expect(indexes.length).toBeGreaterThan(0);
    for (const index of indexes) expect(index.name).toMatch(/^tessar_/);

    db.prepare("INSERT INTO tessar_owned_states VALUES(?,?,?)").run("saved", 1, "{}");
    await initializeSchema(db);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(db.prepare("SELECT body FROM tessar_owned_states WHERE owner_key=?").get("saved")?.body).toBe("{}");
  } finally {
    db.close();
  }
});
