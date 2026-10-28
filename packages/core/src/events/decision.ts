import { fail } from "../errors.js";
import { assertJson } from "../json.js";

const allowed: Readonly<Record<string, readonly string[]>> = {
  "stream.before": ["allow", "deny", "stop", "suspend"],
  "tool.before": ["allow", "deny", "stop", "suspend"],
  "turn.decision": ["allow", "continue", "deny", "stop", "suspend"],
  "model.select": ["allow", "select", "suspend"],
  "model.recover": ["deny", "retry", "suspend"],
  "session.model.before-change": ["allow", "deny"],
  "session.thread.before-switch": ["allow", "deny"],
  "thread.before-fork": ["allow", "deny"],
  "thread.before-rename": ["allow", "deny"],
  "thread.before-delete": ["allow", "deny"],
};

export function validateDecision(name: string, result: unknown): void {
  const values = allowed[name];
  if (!values || result === undefined) return;
  const value = result as Record<string, unknown> | null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.decision !== "string" ||
    !values.includes(value.decision) ||
    (value.reason !== undefined && typeof value.reason !== "string")
  )
    fail("InvalidHookResult", "Unsupported decision for " + name);
  if (value.decision === "select") {
    const model = value.model as Record<string, unknown> | null;
    if (
      !model ||
      typeof model !== "object" ||
      Array.isArray(model) ||
      typeof model.providerId !== "string" ||
      !model.providerId.trim() ||
      typeof model.modelId !== "string" ||
      !model.modelId.trim() ||
      (model.connectionId !== undefined &&
        (typeof model.connectionId !== "string" || !model.connectionId.trim()))
    )
      fail("InvalidHookResult", "Model selection requires model identity");
  }
  if (value.decision === "suspend") {
    if (
      ["definitionId", "pluginId"].some(
        (key) =>
          typeof value[key] !== "string" || !(value[key] as string).trim(),
      ) ||
      !Number.isInteger(value.definitionVersion) ||
      (value.definitionVersion as number) < 1
    )
      fail(
        "InvalidHookResult",
        "Suspension requires a registered interruption identity",
      );
    try {
      assertJson(value.payload);
    } catch {
      fail("InvalidHookResult", "Suspension payload must be JSON");
    }
  }
}
