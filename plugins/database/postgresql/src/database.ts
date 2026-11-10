import type { Pool } from "pg";
import { fail } from "@tessar/core";

export interface PostgresqlStorageOptions {
  pool: Pool;
  schema?: string;
}

export interface Database {
  readonly pool: Pool;
  readonly schema: string;
  readonly table: (name: string) => string;
}

export function openDatabase(options: PostgresqlStorageOptions): Database {
  if (!options.pool || typeof options.pool.connect !== "function")
    fail("InvalidConfiguration", "pool must implement connect");
  const schema = options.schema === undefined ? "tessar" : options.schema;
  if (typeof schema !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema))
    fail("InvalidConfiguration", "Invalid PostgreSQL schema name");
  const table = (name: string) => `"${schema}"."tessar_${name}"`;
  return { pool: options.pool, schema, table };
}
