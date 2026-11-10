import { expect, test } from "vitest";
import { ApiKeyAuth } from "../src/index.js";

test("API key verifies Bearer credentials and returns the configured identity", async () => {
  const auth = new ApiKeyAuth({ key: "private-service-key", identity: { id: "service", roles: ["read"] } });
  expect(await auth.authenticate(new Request("http://test", { headers: { authorization: "Bearer private-service-key" } }))).toEqual({ id: "service", roles: ["read"] });
  for (const header of [undefined, "Basic private-service-key", "Bearer wrong", "Bearer private-service-key extra"])
    expect(await auth.authenticate(new Request("http://test", { headers: header ? { authorization: header } : {} }))).toBeNull();
});
test("API key rejects empty configuration without revealing credentials", () => {
  expect(() => new ApiKeyAuth({ key: "", identity: { id: "service" } })).toThrow();
});
