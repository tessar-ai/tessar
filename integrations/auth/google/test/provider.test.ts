import { beforeAll, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { GoogleAuth } from "../src/index.js";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
beforeAll(async () => { keys = await generateKeyPair("RS256"); jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: "google-test", alg: "RS256" }] }; });
async function token(issuer = "https://accounts.google.com", audience = "web-client") {
  return new SignJWT({ email: "alice@example.com" }).setProtectedHeader({ alg: "RS256", kid: "google-test" }).setSubject("google-alice").setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
}
test("Google verifies provider JWKS, audience and issuer without installing a Google SDK", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(jwks));
  const auth = new GoogleAuth({ clientId: "web-client", fetch: fetcher });
  const request = (value: string) => new Request("http://test", { headers: { authorization: "Bearer " + value } });
  expect(await auth.authenticate(request(await token()))).toMatchObject({ sub: "google-alice" });
  expect(String(fetcher.mock.calls[0]![0])).toBe("https://www.googleapis.com/oauth2/v3/certs");
  expect(await auth.authenticate(request(await token("https://attacker.example")))).toBeNull();
  expect(await auth.authenticate(request(await token(undefined, "other-client")))).toBeNull();
  expect(await auth.authenticate(request("broken"))).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
