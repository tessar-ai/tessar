import type { ClientSession, Collection, Document, Filter } from "mongodb";
import {
  canonicalJson,
  encodeCursor,
  immutable,
  limitOf,
  normalizeScope,
  pageAfter,
  type Page,
  type PageOptions,
  type Scope,
} from "@tessar/core";

// JSON bodies preserve arbitrary JSON keys; indexed fields never interpolate user keys.
export type Row = Document & { _id: string; body: string };
export const decode = <T>(row: Row | null): T | null =>
  row ? (immutable(JSON.parse(row.body)) as T) : null;
export function scopeTokens(scope: Scope = {}): string[] {
  normalizeScope(scope);
  return Object.entries(scope).map(([key, value]) =>
    canonicalJson([key, value]),
  );
}
export function scopeFilter(scope?: Scope): Filter<Row> {
  const tokens = scopeTokens(scope);
  return tokens.length ? { scopeTokens: { $all: tokens } } : {};
}
export async function mongoPage<T>(
  collection: Collection<Row>,
  filter: Filter<Row>,
  options: PageOptions,
  binding: string,
  session?: ClientSession,
  map: (row: Row) => T = (row) => decode<T>(row)!,
): Promise<Page<T>> {
  const after = pageAfter(options, binding),
    limit = limitOf(options.limit);
  const pageFilter = after
    ? {
        $and: [
          filter,
          {
            $or: [
              { sortDate: { $gt: after[0] } },
              { sortDate: after[0], id: { $gt: after[1] } },
            ],
          },
        ],
      }
    : filter;
  const rows = await collection
    .find(pageFilter, { session, collation: { locale: "simple" } })
    .sort({ sortDate: 1, id: 1 })
    .limit(limit + 1)
    .toArray();
  const selected = rows.slice(0, limit),
    last = selected.at(-1);
  return {
    items: selected.map(map),
    nextCursor:
      rows.length > limit
        ? encodeCursor({ v: 2, binding, after: [last!.sortDate, last!.id] })
        : null,
  };
}
