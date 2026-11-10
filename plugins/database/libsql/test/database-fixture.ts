import Database from "libsql";
import { onTestFinished } from "vitest";

export function createTestDatabase(filename: string): Database.Database {
  const database = new Database(filename);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  onTestFinished(() => { database.close(); });
  return database;
}
