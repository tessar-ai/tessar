import type { Db } from "mongodb";
import { fail } from "@tessar/core";

export interface MongoDBStorageOptions {
  database: Db;
  namespace?: string;
}

export interface Database {
  readonly database: Db;
  readonly prefix: string;
}

export function openDatabase({ database, namespace }: MongoDBStorageOptions): Database {
  if (!database || typeof database.collection !== "function" || typeof database.createCollection !== "function"
    || typeof database.client?.startSession !== "function")
    fail("InvalidConfiguration", "database must be a MongoDB Db");
  if (namespace !== undefined &&
    (typeof namespace !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(namespace)))
    fail("InvalidConfiguration", "MongoDB namespace must be an ASCII identifier of at most 63 characters");
  return { database, prefix: namespace === undefined ? "" : `${namespace}_` };
}
