import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  fail,
  immutable,
  prepareStoredRecord,
  requireId,
  type RecordStore,
  type StoredRecord,
} from "@tessar/core";
import { scopePredicate, sqlPage } from "./queries.js";

export function createRecordStore(db: DatabaseSync): RecordStore {
  return {
    append: async (options) => {
      const value = prepareStoredRecord(options);
      const result = db
        .prepare(
          "INSERT INTO tessar_records(namespace,id,created_at,body) VALUES(?,?,?,?) ON CONFLICT(namespace,id) DO NOTHING",
        )
        .run(value.namespace, value.id, value.createdAt, canonicalJson(value));
      if (!result.changes)
        fail("RegistrationConflict", "Record ID already exists in namespace");
      return value;
    },
    get: async (namespace, id, query = {}) => {
      requireId(namespace, "record namespace");
      requireId(id, "record id");
      const scope = scopePredicate(query.scope);
      const row = db
        .prepare(
          `SELECT body FROM tessar_records WHERE namespace=? AND id=? AND ${scope.sql}`,
        )
        .get(namespace, id, ...scope.values);
      return row
        ? (immutable(JSON.parse(String(row.body))) as StoredRecord)
        : null;
    },
    list: async (query) => {
      requireId(query.namespace, "record namespace");
      const scope = scopePredicate(query.scope);
      return sqlPage<StoredRecord>(
        db,
        "records",
        "namespace=? AND " + scope.sql,
        [query.namespace, ...scope.values],
        query,
        canonicalJson({ records: query.namespace, scope: query.scope ?? {} }),
        "created_at",
      );
    },
  };
}
