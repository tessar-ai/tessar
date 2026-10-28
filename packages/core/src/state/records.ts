import { requireId } from "../errors.js";
import { assertJson, immutable, randomIds, systemClock, type JsonValue } from "../json.js";
import { normalizeScope } from "./scope.js";
import type { Page, PageOptions, Scope, StateQuery } from "./schema.js";

/** Independent JSON data, outside conversation history and checkpoint rollback. */
export interface StoredRecord {
  readonly id: string;
  readonly namespace: string;
  readonly scope: Scope;
  readonly data: JsonValue;
  readonly createdAt: string;
}
export interface AppendRecordOptions {
  id?: string;
  namespace: string;
  scope?: Scope;
  data: JsonValue;
}
export interface RecordsQuery extends StateQuery, PageOptions {
  namespace: string;
}
export interface RecordStore {
  append(options: AppendRecordOptions): Promise<StoredRecord>;
  get(namespace: string, id: string, query?: StateQuery): Promise<StoredRecord | null>;
  list(query: RecordsQuery): Promise<Page<StoredRecord>>;
}

/** Shared validation and identity generation for storage implementors. */
export function prepareStoredRecord(
  options: AppendRecordOptions,
  createdAt = systemClock.now(),
): StoredRecord {
  requireId(options.namespace, "record namespace");
  const id = requireId(options.id ?? randomIds.next("record"), "record id");
  const scope = normalizeScope(options.scope);
  assertJson(options.data);
  return immutable({ id, namespace: options.namespace, scope, data: options.data, createdAt });
}
