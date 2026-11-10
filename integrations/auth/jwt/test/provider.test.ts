import { expect, test } from "vitest";
import { SignJWT } from "jose";
import { JwtAuth } from "../src/index.js";

const SECRET = "a-long-test-secret-at-least-32-bytes";
const key = new TextEncoder().encode(SECRET);
const request = (token: string) => new Request("http://test", { headers: { authorization: "Bearer " + token } });
async function token(payload: Record<string, unknown> = {}, signingKey = key, algorithm = "HS256") {
  return new SignJWT(payload).setProtectedHeader({ alg: algorithm }).setSubject("alice").setIssuedAt().setExpirationTime("5m").setIssuer("test-issuer").setAudience("test-api").sign(signingKey);
}
test("JWT verifies signature, identity and configured issuer/audience", async () => {
  const auth = new JwtAuth({ secret: SECRET, issuer: "test-issuer", audience: "test-api" });
  expect(await auth.authenticate(request(await token({ role: "reader" })))).toMatchObject({ sub: "alice", role: "reader" });
  expect(await auth.authenticate(new Request("http://test"))).toBeNull();
  expect(await auth.authenticate(request(await token({}, new TextEncoder().encode("another-long-test-secret-32-bytes!!"))))).toBeNull();
  expect(await new JwtAuth({ secret: SECRET, issuer: "other" }).authenticate(request(await token()))).toBeNull();
  expect(await new JwtAuth({ secret: SECRET, audience: "other" }).authenticate(request(await token()))).toBeNull();
  expect(await auth.authenticate(request(await token({}, key, "HS384")))).toBeNull();
});
test("JWT rejects expired, future, missing claims and malformed tokens", async () => {
  const auth = new JwtAuth({ secret: SECRET });
  for (const payload of [{ sub: "alice", exp: 1 }, { sub: "alice", exp: 9999999999, nbf: 9999999998 }, { sub: "alice" }, { exp: 9999999999 }]) {
    const signed = await new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).sign(key);
    expect(await auth.authenticate(request(signed))).toBeNull();
  }
  expect(await auth.authenticate(request("broken"))).toBeNull();
  expect(() => new JwtAuth({ secret: "short" })).toThrow();
});
