import type { PoolClient } from "pg";
import { fail } from "@tessar/core";
import type { Database } from "./database.js";

export async function transaction<T>(
  db: Database,
  action: (client: PoolClient) => Promise<T>,
  keys?: readonly string[],
): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query(
      keys ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    // Sorted resource locks also serialize creation, where no row exists to lock yet.
    for (const key of [...new Set(keys ?? [])].sort())
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [db.schema + ":" + key],
      );
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* Preserve the original driver error. */
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function storageTransaction<T>(
  db: Database,
  action: (client: PoolClient) => Promise<T>,
  keys?: readonly string[],
): Promise<T> {
  try {
    return await transaction(db, action, keys);
  } catch (error) {
    if ((error as { code?: string }).code === "23505")
      fail("CommitConflict", "Storage key already exists");
    throw error;
  }
}
