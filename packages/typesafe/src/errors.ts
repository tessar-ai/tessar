import { TessarError, type JsonValue } from "@tessar/core";

/** HTTP provider failure, with its original body and response identity. */
export class TypeSafeAPIError extends TessarError {
  readonly name = "TypeSafeAPIError";
  constructor(
    readonly status: number,
    readonly body: JsonValue,
    readonly requestId: string | null,
  ) {
    super("TypeSafeAPIError", `TypeSafe HTTP ${status}`, {
      source: "provider",
      details: { status, body, requestId },
    });
  }
}

/** The provider returned HTTP success without a valid native response. */
export class TypeSafeResponseError extends TessarError {
  readonly name = "TypeSafeResponseError";
  constructor(
    message: string,
    readonly body: string,
  ) {
    super("TypeSafeResponseError", message, {
      source: "provider",
      details: { body },
    });
  }
}
