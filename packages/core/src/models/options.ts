import { fail } from "../errors.js";
import { immutable, type JsonObject } from "../json.js";

/** Runtime/connection fields belong outside per-request model options. */
export function validateModelOptions(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("InvalidConfiguration", "Model options must be an object");
  for (const key of [
    "api",
    "model",
    "input",
    "messages",
    "instructions",
    "tools",
    "stream",
    "apiKey",
    "baseURL",
    "defaultHeaders",
    "maxRetries",
    "timeout",
    "connectionId",
  ])
    if (key in value) fail("UnsupportedOption", key + " is not a model option");
}

/** Snapshot JSON request options using SDK-compatible omission of undefined. */
export function snapshotModelOptions(value: object): JsonObject {
  const json = JSON.stringify(value, (_key, item) => {
    if (
      ["function", "symbol", "bigint"].includes(typeof item) ||
      (typeof item === "number" && !Number.isFinite(item))
    )
      fail("InvalidConfiguration", "Model options must be JSON data");
    return item;
  });
  return immutable(JSON.parse(json)) as JsonObject;
}
