import { fail, requireId } from "../errors.js";
import { immutable } from "../helpers/json.js";
import { canonicalJson } from "./commit.js";
import { matchesScope, normalizeScope } from "./scope.js";
import type { SessionRecord, ThreadInfo } from "./schema.js";

export function validateSession(
  value: SessionRecord,
  previous: SessionRecord | null,
  expected: number,
  thread: ThreadInfo | null,
): void {
  requireId(value.id);
  requireId(value.agentId);
  normalizeScope(value.scope);
  immutable(value);
  if ((previous?.revision ?? 0) !== expected || value.revision !== expected + 1)
    fail("CommitConflict", "Session revision changed");
  if (
    previous &&
    (previous.agentId !== value.agentId ||
      canonicalJson(previous.scope) !== canonicalJson(value.scope) ||
      previous.createdAt !== value.createdAt)
  )
    fail("InvalidConfiguration", "Session identity and scope are immutable");
  if (
    value.selectedThreadId &&
    (!thread || thread.deleted || !matchesScope(thread.scope, value.scope))
  )
    fail("ThreadNotFound", "Selected thread does not match Session scope");
}
