import { beforeAll, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ClerkAuth } from "../src/index.js";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
const ISSUER = "https://example.clerk.accounts.dev";
beforeAll(async () => { keys = await generateKeyPair("RS256"); jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: "clerk-test", alg: "RS256" }] }; });
async function token(payload: Record<string, unknown> = {}, issuer = ISSUER) {
  return new SignJWT({ sid: "session-1", azp: "https://app.example", ...payload }).setProtectedHeader({ alg: "RS256", kid: "clerk-test" }).setSubject("clerk-alice").setIssuer(issuer).setNotBefore("0s").setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
}
test("Clerk verifies session claims and configured authorized parties", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(jwks));
  const auth = new ClerkAuth({ issuer: ISSUER, authorizedParties: ["https://app.example"], fetch: fetcher });
  const request = (value: string) => new Request("http://test", { headers: { authorization: "Bearer " + value } });
  expect(await auth.authenticate(request(await token()))).toMatchObject({ sub: "clerk-alice", sid: "session-1" });
  expect(String(fetcher.mock.calls[0]![0])).toBe(ISSUER + "/.well-known/jwks.json");
  expect(await auth.authenticate(request(await token({ azp: "https://attacker.example" })))).toBeNull();
  expect(await auth.authenticate(request(await token({ sts: "pending" })))).toBeNull();
  expect(await auth.authenticate(request(await token({}, "https://attacker.example")))).toBeNull();
  expect(await auth.authenticate(new Request("http://test"))).toBeNull();
  expect(() => new ClerkAuth({ issuer: "http://insecure.example" })).toThrow();
});
