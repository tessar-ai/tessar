import {
  canonicalJson,
  fail,
  immutable,
  prepareStoredRecord,
  requireId,
  type RecordStore,
  type StoredRecord,
} from "@tessar/core";
import type { Database } from "./database.js";
import { page, scopeFilter } from "./queries.js";

export function createRecordStore(db: Database): RecordStore {
  const table = db.table("records");
  return {
    append: async (options) => {
      const value = prepareStoredRecord(options);
      return db.transaction(async (client) => {
        const result = await client.query(
          `INSERT INTO ${table}(namespace,id,created_at,body) VALUES($1,$2,$3,$4) ON CONFLICT(namespace,id) DO NOTHING`,
          [value.namespace, value.id, value.createdAt, canonicalJson(value)],
        );
        if (!result.rowCount)
          fail("RegistrationConflict", "Record ID already exists in namespace");
        return value;
      }, []);
    },
    get: async (namespace, id, query = {}) => {
      requireId(namespace, "record namespace");
      requireId(id, "record id");
      const values: unknown[] = [namespace, id];
      const scope = scopeFilter(query.scope, values);
      return db.transaction(async (client) => {
        const { rows } = await client.query(
          `SELECT body FROM ${table} WHERE namespace=$1 AND id=$2 AND ${scope}`,
          values,
        );
        return rows[0] ? (immutable(rows[0].body) as StoredRecord) : null;
      });
    },
    list: async (query) => {
      requireId(query.namespace, "record namespace");
      const values: unknown[] = [query.namespace];
      const scope = scopeFilter(query.scope, values);
      return db.transaction((client) =>
        page<StoredRecord>(
          client,
          table,
          "namespace=$1 AND " + scope,
          values,
          query,
          canonicalJson({ records: query.namespace, scope: query.scope ?? {} }),
          "created_at",
        ),
      );
    },
  };
}
