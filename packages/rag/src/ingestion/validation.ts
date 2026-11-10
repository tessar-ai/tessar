import { fail } from "@tessar/core";

export function object(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail("InvalidConfiguration", label + " must be a plain object");
}

export function keys(value: object, allowed: readonly string[]): void {
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !allowed.includes(key),
    )
  )
    fail("InvalidConfiguration", "Unexpected input field");
}
