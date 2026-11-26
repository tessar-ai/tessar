import { TessarError } from "@tessar/core";

export class TessarWorkspaceError extends TessarError { }

const INVALID_PATCH = "InvalidPatch";
const INVALID_PATH = "InvalidPath";
const INVALID_CONFIGURATION = "InvalidConfiguration";

export function invalidConfiguration(message: string, cause?: unknown): never {
  throw new TessarWorkspaceError(INVALID_CONFIGURATION, message, { cause });
}

export function invalidPatch(message: string): never {
  throw new TessarWorkspaceError(INVALID_PATCH, message, { source: "tool" });
}

export function invalidPath(message: string): never {
  throw new TessarWorkspaceError(INVALID_PATH, message, { source: "tool" });
}
