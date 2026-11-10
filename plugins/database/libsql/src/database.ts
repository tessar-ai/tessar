import type Libsql from "libsql";
import { fail } from "@tessar/core";

export interface LibsqlStorageOptions {
  database: Libsql.Database;
  namespace?: string;
}

export type SQLInputValue = string | number | bigint | Uint8Array | null;
export interface Database {
  readonly prefix: string;
  readonly prepare: Libsql.Database["prepare"];
  readonly exec: Libsql.Database["exec"];
}

/** SQL names and connection access for one Tessar namespace; never owns the driver. */
export function openDatabase({ database, namespace }: LibsqlStorageOptions): Database {
  if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function")
    fail("InvalidConfiguration", "database must be a libsql Database");
  if (namespace !== undefined && (typeof namespace !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(namespace)))
    fail("InvalidConfiguration", "libSQL namespace must be a lowercase ASCII identifier of at most 63 characters");
  const prefix = namespace === undefined ? "" : namespace + "_";
  const prepare = database.prepare.bind(database);
  const exec = database.exec.bind(database);
  exec("PRAGMA foreign_keys=ON");
  return { prefix, prepare, exec };
}
