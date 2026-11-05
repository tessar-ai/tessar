import { expect, test, vi } from "vitest";
import { Hono } from "hono";
import { TessarError, errorInfo } from "@tessar/core";
import { bad, required, httpError } from "../src/protocal/http.js";
import { TessarServerError, registerRoute } from "../src/index.js";

test("server-owned errors use the public subclass and preserve cause and serialization", () => {
  const cause = new Error("original");
  const error = new TessarServerError("InvalidRequest", "bad request", { cause });
  expect(error).toBeInstanceOf(TessarError);
  expect(error.cause).toBe(cause);
  expect(error.toJSON()).toMatchObject({ name: "TessarServerError", code: "InvalidRequest", source: "tessar" });
  expect(() => bad("bad request")).toThrow(TessarServerError);
  expect(() => required(null)).toThrow(TessarServerError);
  expect(() => registerRoute("invalid", { method: "GET", handler: () => new Response() })).toThrow(TessarServerError);
});

test("HTTP responses identify server-owned exceptions", async () => {
  const app = new Hono(); app.onError(httpError);
  app.get("/invalid", () => bad("bad request"));
  app.get("/missing", () => required<Response>(null));
  for (const [path, status, code] of [["/invalid", 400, "InvalidRequest"], ["/missing", 404, "NotFound"]] as const) {
    const response = await app.request(path);
    expect(response.status).toBe(status);
    expect((await response.json()).error).toMatchObject({ name: "TessarServerError", code, source: "tessar" });
  }
});

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

test.each(["ThreadNotDeleted", "ThreadReferenced", "RecoveryRequired", "InvalidTransition"])("maps %s to a state conflict", async code => {
  const app = new Hono(); app.onError(httpError);
  app.get("/", () => { throw new TessarError(code, "Resolve the current state first"); });
  const response = await app.request("/");
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe(code);
});
