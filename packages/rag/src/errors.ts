import { TessarError } from "@tessar/core";

export class TessarRagError extends TessarError {
  readonly name = "TessarRagError";
}

/** Attribute shared core validation failures without wrapping external errors. */
export function asRagError(error: unknown): unknown {
  if (
    TessarError.isInstance(error) &&
    error.constructor === TessarError &&
    error.source === "tessar"
  )
    return new TessarRagError(error.code, error.message, {
      source: error.source,
      details: error.details,
      cause: error,
    });
  return error;
}
