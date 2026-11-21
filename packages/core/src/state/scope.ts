import { fail } from "../errors.js";
import { immutable } from "../helpers/json.js";
import type { Scope } from "./schema.js";
export function normalizeScope(value: Scope = {}): Scope {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("InvalidConfiguration", "Scope must be an object");
  for (const entry of Object.values(value))
    if (
      !["string", "number", "boolean"].includes(typeof entry) ||
      (typeof entry === "number" && !Number.isFinite(entry))
    )
      fail("InvalidConfiguration", "Scope values must be finite scalars");
  return immutable(value);
}
export function matchesScope(state: Scope, filter: Scope = {}): boolean {
  normalizeScope(filter);
  return Object.keys(filter).every(
    (key) => Object.hasOwn(state, key) && state[key] === filter[key],
  );
}
