import { TessarError } from "@tessar/core";

export const SERVER_ERROR_CODE = {
  DISPOSED: "Disposed",
  AGENT_NOT_FOUND: "AgentNotFound",
  CONTROLLER_NOT_FOUND: "ControllerNotFound",
  UNAUTHORIZED: "Unauthorized",
  FORBIDDEN: "Forbidden",
  INVALID_AUTH_RESULT: "InvalidAuthResult",
} as const;

export class TessarServerError extends TessarError {
  readonly name = "TessarServerError";
}
