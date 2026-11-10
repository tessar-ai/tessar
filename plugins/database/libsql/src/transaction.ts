import type { Database } from "./database.js";

export function transaction<T>(db: Database, action: () => T, mode: "read" | "write" = "write"): T {
  db.exec(mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Preserve the original driver error. */ }
    throw error;
  }
}
