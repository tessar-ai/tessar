import { Pool } from "pg";
import { PostgresqlStoragePlugin } from "@tessar/postgresql";

export function createStorage() {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("Set POSTGRES_URL in .env.");
  const pool = new Pool({ connectionString });
  return { plugin: new PostgresqlStoragePlugin({ pool, schema: "tessar" }), close: () => pool.end() };
}
