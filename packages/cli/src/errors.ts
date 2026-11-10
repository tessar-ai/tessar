import { TessarError } from "@tessar/core";

export const CLI_ERROR_CODE = {
  INVALID_ARGUMENTS: "InvalidArguments",
  INVALID_NAME: "InvalidName",
  TARGET_EXISTS: "TargetExists",
  INVALID_PROJECT: "InvalidProject",
  UNSAFE_PATH: "UnsafePath",
  INVALID_TEMPLATE: "InvalidTemplate",
  INVALID_CONFIGURATION: "InvalidConfiguration",
} as const;

export class TessarCLIError extends TessarError {
  readonly name = "TessarCLIError";
}
