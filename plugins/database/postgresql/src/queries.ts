import type { PoolClient } from "pg";
import {
  canonicalJson,
  immutable,
  normalizeScope,
  pageAfter,
  limitOf,
  encodeCursor,
  type Scope,
  type PageOptions,
  type Page,
} from "@tessar/core";

export function scopeFilter(scope: Scope = {}, values: unknown[]): string {
  normalizeScope(scope);
  values.push(canonicalJson(scope));
  return `body->'scope' @> $${values.length}::jsonb`;
}
export async function page<T>(
  client: PoolClient,
  table: string,
  where: string,
  values: unknown[],
  options: PageOptions,
  binding: string,
  date: string,
  map: (row: any) => T = (row) => immutable(row.body),
  columns = "*",
): Promise<Page<T>> {
  const after = pageAfter(options, binding),
    limit = limitOf(options.limit);
  if (after) {
    values.push(after[0], after[1]);
    where += ` AND (${date},id COLLATE "C")>($${values.length - 1},$${values.length})`;
  }
  values.push(limit + 1);
  const { rows } = await client.query(
    `SELECT ${columns},${date} AS page_date FROM ${table} WHERE ${where} ORDER BY ${date},id COLLATE "C" LIMIT $${values.length}`,
    values,
  );
  const selected = rows.slice(0, limit),
    last = selected.at(-1);
  return {
    items: selected.map(map),
    nextCursor:
      rows.length > limit
        ? encodeCursor({ v: 2, binding, after: [last!.page_date, last!.id] })
        : null,
  };
}
