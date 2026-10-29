import { Pool, type PoolClient, type PoolConfig } from "pg";
import { fail } from "@tessar/core";

export interface PostgresqlStorageOptions {
  connectionString: string;
  schema?: string;
  driverOptions?: Omit<PoolConfig, "connectionString">;
}
export type Database = ReturnType<typeof openDatabase>;

export function openDatabase(options: PostgresqlStorageOptions) {
  const schema = options.schema ?? "tessar";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema))
    fail("InvalidConfiguration", "Invalid PostgreSQL schema name");
  const table = (name: string) => `"${schema}"."${name}"`;
  const pool = new Pool({
    ...options.driverOptions,
    connectionString: options.connectionString,
  });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= pool.end());
  async function transaction<T>(
    action: (client: PoolClient) => Promise<T>,
    keys?: readonly string[],
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(
        keys ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      // Sorted resource locks also serialize creation, where no row exists to lock yet.
      for (const key of [...new Set(keys ?? [])].sort())
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [schema + ":" + key],
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
      if ((error as { code?: string }).code === "23505")
        fail("CommitConflict", "Storage key already exists");
      throw error;
    } finally {
      client.release();
    }
  }
  return { schema, table, transaction, close };
}
