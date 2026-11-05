import { fail } from "./errors.js";

const INVALID_DATA = "InvalidData";
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
export function assertJson(
  value: unknown,
  parents = new Set<object>(),
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || parents.has(value!))
    fail(INVALID_DATA, "Value is not serializable JSON");
  const object = value as object;
  if (
    !Array.isArray(object) &&
    Object.getPrototypeOf(object) !== Object.prototype &&
    Object.getPrototypeOf(object) !== null
  )
    fail(INVALID_DATA, "JSON objects must be plain data");
  if (Object.getOwnPropertySymbols(object).length)
    fail(INVALID_DATA, "Symbol keys are not JSON");
  parents.add(object);
  if (Array.isArray(object)) {
    for (let i = 0; i < object.length; i++) assertJson(object[i], parents);
  } else {
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(object),
    )) {
      if (!("value" in descriptor))
        fail(INVALID_DATA, "Accessors are not JSON data");
      assertJson(descriptor.value, parents);
    }
  }
  parents.delete(object);
}
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as Readonly<T>;
}
export function immutable<T>(value: T): Readonly<T> {
  assertJson(value);
  return deepFreeze(structuredClone(value));
}
export interface Clock {
  now(): string;
}
export interface IdGenerator {
  next(kind: string): string;
}
export const systemClock: Clock = { now: () => new Date().toISOString() };
export const randomIds: IdGenerator = {
  next: () => globalThis.crypto.randomUUID(),
};
