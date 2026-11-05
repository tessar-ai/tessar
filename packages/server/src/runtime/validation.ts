import { TessarServerError } from "../errors.js";

export function invalid(message: string): never {
  throw new TessarServerError("InvalidConfiguration", message);
}
export function fields(value: unknown, allowed: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key))) invalid("Unexpected configuration fields");
}
