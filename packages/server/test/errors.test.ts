import { expect, test, vi } from "vitest";
import { Hono } from "hono";
import { TessarError, errorInfo } from "@tessar/core";
import { httpError } from "../src/http.js";

test("HTTP errors preserve origin and safe upstream status without exposing secrets", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => { });
  try {
    const provider = Object.assign(new Error("secret api key"), { status: 401 });
    errorInfo(provider, { source: "provider", providerId: "test" });
    const cases = [[provider, 502], [new TessarError("SessionBusy", "busy"), 409],
    [new TessarError("CommitConflict", "stale"), 409], [new TessarError("ThreadNotFound", "missing"), 404],
    [new TessarError("InvalidCursor", "bad"), 400], [new Error("secret password"), 500]] as const;
    for (const [error, expected] of cases) {
      const app = new Hono(); app.onError(httpError); app.get("/", () => { throw error; });
      const response = await app.request("/");
      expect(response.status).toBe(expected);
      const json = await response.json();
      expect(JSON.stringify(json)).not.toContain("secret");
      expect(JSON.stringify(json)).not.toContain("stack");
      if (error === provider) expect(json.error).toMatchObject({ source: "provider", details: { status: 401 } });
    }
  } finally { log.mockRestore(); }
});

test("provider and application codes cannot impersonate local SDK errors", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => { });
  try {
    for (const code of ["NotFoundError", "InvalidApiKey"]) {
      const error = Object.assign(new Error("sentinel secret"), { code, status: 401 });
      errorInfo(error, { source: "provider" });
      const app = new Hono(); app.onError(httpError); app.get("/", () => { throw error; });
      const response = await app.request("/");
      expect(response.status).toBe(502); expect(await response.text()).not.toContain("sentinel secret");
    }
    const error = Object.assign(new Error("sentinel secret"), { code: "InvalidRequest" });
    errorInfo(error, { source: "application" });
    const app = new Hono(); app.onError(httpError); app.get("/", () => { throw error; });
    const response = await app.request("/"); expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("sentinel secret");
  } finally { log.mockRestore(); }
});
