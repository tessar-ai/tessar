import { MongoServerError, type ClientSession } from "mongodb";
import { fail } from "@tessar/core";
import type { Database } from "./database.js";

export async function transaction<T>(
  db: Database,
  action: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = db.database.client.startSession();
  let failed = false;
  try {
    return (await session.withTransaction(() => action(session), {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary",
    }))!;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await session.endSession(); }
    catch (error) { if (!failed) throw error; }
  }
}

export async function storageTransaction<T>(
  db: Database,
  action: (session: ClientSession) => Promise<T>,
): Promise<T> {
  try {
    return await transaction(db, action);
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000)
      fail("CommitConflict", "Storage identity or revision already exists");
    throw error;
  }
}
