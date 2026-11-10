import { matchesScope, normalizeScope, type Scope } from "@tessar/core";
import type { Context } from "hono";
import type { AuthOptions } from "../auth.js";
import { TessarServerError, SERVER_ERROR_CODE } from "../errors.js";
import { fields, invalid } from "../runtime/validation.js";

const AUTH_SCOPE_KEY = "tessar.auth.scope";
export function snapshotAuth<User>(auth: AuthOptions<User> | undefined): Readonly<AuthOptions<User>> | undefined {
  if (auth === undefined) return;
  fields(auth, ["provider", "authorize", "scope"]);
  if (!auth.provider || typeof auth.provider.authenticate !== "function") invalid("auth.provider must implement authenticate");
  for (const callback of [auth.authorize, auth.scope])
    if (callback !== undefined && typeof callback !== "function") invalid("Auth callbacks must be functions");
  return Object.freeze({ ...auth });
}

export async function authenticate(c: Context, auth: AuthOptions<any>): Promise<void> {
  const user: unknown = await auth.provider.authenticate(c.req.raw.clone());
  if (user === null) throw new TessarServerError(SERVER_ERROR_CODE.UNAUTHORIZED, "Authentication required");
  if (!user || typeof user !== "object" || Array.isArray(user)) invalidResult();
  if (auth.authorize) {
    const allowed: unknown = await auth.authorize({ user, request: c.req.raw.clone() });
    if (typeof allowed !== "boolean") invalidResult();
    if (!allowed) throw new TessarServerError(SERVER_ERROR_CODE.FORBIDDEN, "Request not permitted");
  }
  if (auth.scope) {
    const value: unknown = await auth.scope(user);
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidResult();
    try { c.set(AUTH_SCOPE_KEY, normalizeScope(value as Scope)); }
    catch { invalidResult(); }
  }
}
function invalidResult(): never {
  throw new TessarServerError(SERVER_ERROR_CODE.INVALID_AUTH_RESULT, "Invalid authentication policy result");
}
export function authScope(c: Context): Scope | undefined { return c.get(AUTH_SCOPE_KEY); }
export function scoped(c: Context, requested?: Scope): Scope | undefined {
  const boundary = authScope(c);
  if (boundary === undefined) return requested;
  const extra = requested === undefined ? {} : normalizeScope(requested);
  if (Object.keys(boundary).some(key => Object.hasOwn(extra, key) && extra[key] !== boundary[key]))
    throw new TessarServerError(SERVER_ERROR_CODE.FORBIDDEN, "Scope conflicts with authenticated identity");
  return normalizeScope({ ...extra, ...boundary });
}
export function visible(scope: Scope, boundary?: Scope): boolean {
  return boundary === undefined || matchesScope(scope, boundary);
}
