import Database from "libsql";
import { LibsqlStoragePlugin } from "@tessar/libsql";

export function createStorage() {
  const path = process.env.LIBSQL_PATH;
  if (!path) throw new Error("Set LIBSQL_PATH in .env.");
  const database = new Database(path);
  return { plugin: new LibsqlStoragePlugin({ database }), close: () => database.close() };
}
