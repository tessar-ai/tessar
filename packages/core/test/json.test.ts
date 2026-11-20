import { expect, it, vi } from "vitest";
import { assertJson, deepFreeze, immutable } from "../src/json.js";

it("does not traverse Tessar's validated immutable snapshots again", () => {
  const snapshot = immutable({ history: [{ text: "previous", metadata: { project: "one" } }] });
  const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptors");
  let traversals: number;
  try { assertJson(snapshot); traversals = descriptors.mock.calls.length; }
  finally { descriptors.mockRestore(); }
  expect(traversals).toBe(0);
});

it("revalidates caller-owned objects even when their outer object is frozen", () => {
  const nested = { value: 1 };
  const input = Object.freeze({ nested });
  assertJson(input);
  const snapshot = immutable(input);
  nested.value = NaN;
  expect(() => assertJson(input)).toThrow();
  expect(() => immutable(input)).toThrow();
  expect(snapshot.nested.value).toBe(1);
});

it("does not treat deepFreeze as JSON validation", () => {
  const invalid = deepFreeze({ value: NaN });
  expect(() => assertJson(invalid)).toThrow();
  expect(() => immutable(invalid)).toThrow();
});

it("does not trust non-JSON descendants in extra array properties", () => {
  const input = Object.assign([], { extra: new Date(0) });
  const snapshot = immutable(input);
  expect(() => assertJson(snapshot.extra)).toThrow();
});

it("does not trust a non-JSON value returned by an array accessor during cloning", () => {
  let reads = 0;
  const input = Object.defineProperty([], "0", {
    enumerable: true, get: () => ++reads === 1 ? 0 : new Date(0),
  });
  const snapshot = immutable(input);
  expect(() => assertJson(snapshot)).toThrow();
});

it("does not trust array indices that structuredClone turns into holes", () => {
  const input = Object.defineProperty([], "0", { value: 1, enumerable: false });
  const snapshot = immutable(input);
  expect(() => assertJson(snapshot)).toThrow();
});

it("validates the detached graph when source inspection changes earlier properties", () => {
  const input: { value: unknown } = { value: 0 };
  Object.defineProperty(input, "ignored", {
    enumerable: false,
    value: new Proxy({}, { ownKeys() { input.value = new Date(0); return []; } }),
  });
  const snapshot = immutable(input);
  expect(() => assertJson(snapshot)).toThrow();
});

it("keeps valid extra array properties detached, frozen and validated", () => {
  const input = Object.assign([1], { extra: { text: "original" } });
  const snapshot = immutable(input);
  input.extra.text = "changed";
  expect(snapshot.extra.text).toBe("original");
  expect(Object.isFrozen(snapshot.extra)).toBe(true);
  expect(() => assertJson(snapshot.extra)).not.toThrow();
});

it("keeps immutable copies detached, deeply frozen and internally aliased", () => {
  const shared = { value: 1 };
  const source = { a: shared, b: shared };
  const snapshot = immutable(source);
  const copy = immutable(snapshot);
  expect(copy).not.toBe(snapshot);
  expect(copy.a).not.toBe(snapshot.a);
  expect(copy.a).toBe(copy.b);
  shared.value = 2;
  expect(copy.a.value).toBe(1);
  expect(Object.isFrozen(copy.a)).toBe(true);
  expect(() => { copy.a.value = 3; }).toThrow();
});

it.each([
  { value: undefined }, { value: Infinity }, { value: BigInt(1) },
  { [Symbol("secret")]: 1 }, new Array(1), new Date(),
  Object.defineProperty({}, "value", { enumerable: true, get: () => 1 }),
])("rejects untrusted non-JSON input %#", input => {
  expect(() => assertJson(input)).toThrow();
  expect(() => immutable(input)).toThrow();
});
