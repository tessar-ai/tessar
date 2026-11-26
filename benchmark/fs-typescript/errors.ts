import { TessarError } from "@tessar/core";

export class TessarFsError extends TessarError { }

const INVALID_PATCH = "InvalidPatch";
const INVALID_PATH = "InvalidPath";
const INVALID_CONFIGURATION = "InvalidConfiguration";

export function invalidConfiguration(message: string): never {
  throw new TessarFsError(INVALID_CONFIGURATION, message);
}

export function invalidPatch(message: string): never {
  throw new TessarFsError(INVALID_PATCH, message, { source: "tool" });
}

export function invalidPath(message: string): never {
  throw new TessarFsError(INVALID_PATH, message, { source: "tool" });
}
