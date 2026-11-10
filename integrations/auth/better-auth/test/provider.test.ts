import { expect, test, vi } from "vitest";
import { BetterAuthProvider } from "../src/index.js";

test("Better Auth delegates session verification using the original cookie/header credentials", async () => {
  const session = { user: { id: "alice", email: "alice@example.com" }, session: { id: "session-1" } };
  const getSession = vi.fn().mockResolvedValueOnce(session).mockResolvedValueOnce(null);
  const provider = new BetterAuthProvider({ auth: { api: { getSession } } });
  const request = new Request("http://test", { headers: { cookie: "session=opaque", authorization: "Bearer provider-token" } });
  expect(await provider.authenticate(request)).toBe(session);
  const { headers } = getSession.mock.calls[0]![0];
  expect(headers.get("cookie")).toBe("session=opaque");
  expect(headers.get("authorization")).toBe("Bearer provider-token");
  expect(await provider.authenticate(request)).toBeNull();
  expect(() => new BetterAuthProvider({ auth: {} as never })).toThrow();
});
