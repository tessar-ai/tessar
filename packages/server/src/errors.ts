import { TessarError } from "@tessar/core";

export class TessarServerError extends TessarError {
  readonly name = "TessarServerError";
}
