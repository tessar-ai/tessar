import {
  assertJson,
  errorInfo,
  type JsonObject,
  type ModelRef,
} from "@tessar/core";

export function responseError(
  ref: ModelRef,
  message: string,
  code = "ProviderResponse",
): Error {
  const error = Object.assign(new Error(message), { code });
  errorInfo(error, { source: "provider", ...ref });
  return error;
}

export function functionArguments(value: string, ref: ModelRef): JsonObject {
  let args: unknown;
  try {
    args = JSON.parse(value);
    assertJson(args);
  } catch {
    throw responseError(ref, "Invalid function arguments");
  }
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw responseError(ref, "Function arguments must be an object");
  return args as JsonObject;
}

export function functionIdentity(
  ref: ModelRef,
  id: unknown,
  name: unknown,
): { toolCallId: string; name: string } {
  if (typeof id !== "string" || !id || typeof name !== "string" || !name)
    throw responseError(ref, "Missing function identity");
  return { toolCallId: id, name };
}
