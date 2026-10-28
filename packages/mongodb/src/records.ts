import { MongoServerError, type Collection } from "mongodb";
import {
  canonicalJson,
  fail,
  prepareStoredRecord,
  requireId,
  type RecordStore,
  type StoredRecord,
} from "@tessar/core";
import {
  decode,
  mongoPage,
  scopeFilter,
  scopeTokens,
  type Row,
} from "./queries.js";

export function createRecordStore(collection: Collection<Row>): RecordStore {
  return {
    append: async (options) => {
      const value = prepareStoredRecord(options);
      try {
        await collection.insertOne({
          _id: canonicalJson([value.namespace, value.id]),
          id: value.id,
          namespace: value.namespace,
          sortDate: value.createdAt,
          scopeTokens: scopeTokens(value.scope),
          body: canonicalJson(value),
        });
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000)
          fail("RegistrationConflict", "Record ID already exists in namespace");
        throw error;
      }
      return value;
    },
    get: async (namespace, id, query = {}) => {
      requireId(namespace, "record namespace");
      requireId(id, "record id");
      return decode<StoredRecord>(
        await collection.findOne({
          _id: canonicalJson([namespace, id]),
          ...scopeFilter(query.scope),
        }),
      );
    },
    list: async (query) => {
      requireId(query.namespace, "record namespace");
      return mongoPage<StoredRecord>(
        collection,
        { namespace: query.namespace, ...scopeFilter(query.scope) },
        query,
        canonicalJson({ records: query.namespace, scope: query.scope ?? {} }),
      );
    },
  };
}
