import { fail } from "../errors.js";
import { assertJson, immutable } from "../json.js";
import type { ProviderRequest } from "./contract.js";

/** Validate each replacement before another handler can observe it. */
export function validateProviderRequest(
  value: unknown,
  original: ProviderRequest,
): ProviderRequest {
  try {
    assertJson(value);
  } catch {
    fail(
      "InvalidHookResult",
      "Provider request must contain serializable JSON",
    );
  }
  const request = value as Partial<ProviderRequest> | null;
  if (
    !request ||
    Array.isArray(request) ||
    !request.body ||
    typeof request.body !== "object" ||
    Array.isArray(request.body) ||
    !request.model ||
    typeof request.model !== "object" ||
    Array.isArray(request.model) ||
    typeof request.protocol !== "string" ||
    !request.protocol.trim() ||
    typeof request.attemptId !== "string" ||
    !request.attemptId.trim() ||
    !["primary", "auxiliary"].includes(request.purpose ?? "")
  )
    fail(
      "InvalidHookResult",
      "Provider request requires a JSON body and execution identity",
    );
  for (const key of ["providerId", "modelId", "connectionId"] as const)
    if (request.model[key] !== original.model[key])
      fail(
        "InvalidHookResult",
        "Provider request cannot change model identity",
      );
  if (Object.keys(request.model).length !== Object.keys(original.model).length)
    fail("InvalidHookResult", "Provider request cannot change model identity");
  for (const key of ["protocol", "attemptId", "purpose"] as const)
    if (request[key] !== original[key])
      fail("InvalidHookResult", "Provider request cannot change " + key);
  return immutable(request) as ProviderRequest;
}
