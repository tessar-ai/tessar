import { expect, it } from "vitest";
import { TessarError, errorInfo } from "@tessar/core";
import { TypeSafeAPIError, TypeSafeResponseError } from "../src/index.js";

it("inherits the shared guard and preserves concrete fields and provider source", () => {
  const http = new TypeSafeAPIError(429, { detail: "busy" }, "request-1");
  const malformed = new TypeSafeResponseError("Invalid response", "raw body");
  expect(TessarError.isInstance(http)).toBe(true);
  expect(TessarError.isInstance(malformed)).toBe(true);
  expect(TypeSafeAPIError.isInstance(http)).toBe(true);
  expect(TypeSafeAPIError.isInstance(malformed)).toBe(false);
  expect(TypeSafeResponseError.isInstance(malformed)).toBe(true);
  expect(Object.hasOwn(TypeSafeAPIError, "isInstance")).toBe(false);
  expect(http).toMatchObject({ status: 429, body: { detail: "busy" }, requestId: "request-1", source: "provider" });
  expect(errorInfo(http, { source: "tool", toolName: "guardrail" })).toMatchObject({
    source: "provider", name: "TypeSafeAPIError", code: "TypeSafeAPIError",
    details: { status: 429, body: { detail: "busy" }, requestId: "request-1" },
  });
  expect(malformed.toJSON()).toMatchObject({ source: "provider", code: "TypeSafeResponseError", details: { body: "raw body" } });
});
