import { afterEach, expect, test, vi, expectTypeOf } from "vitest";
import { Agent, Controller } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { Tessar, registerRoute, registerMiddleware } from "../src/index.js";
import type { AuthProvider } from "../src/index.js";
import { start } from "./helpers.js";

type User = { id: string; role: string };
const provider: AuthProvider<User> = { async authenticate(request) {
  const id = request.headers.get("x-user");
  return id ? { id, role: id === "admin" ? "admin" : "reader" } : null;
} };
let host: Awaited<ReturnType<typeof start>> | undefined;
afterEach(async () => { await host?.server.shutdown(); host = undefined; });

test("auth is optional and custom routes/middleware remain developer-owned", async () => {
  host = await start({ server: { auth: { provider }, routes: [registerRoute("/auth/login", { method: "POST", handler: c => c.json({ token: "issued-by-dev" }) })] } });
  expect((await host.request("/api/agents")).status).toBe(401);
  expect((await host.request("/auth/login", "POST", {})).status).toBe(200);
  expect((await host.request("/openapi.json")).status).toBe(200);
  expect((await fetch(host.url + "/api/agents", { headers: { "x-user": "alice" } })).status).toBe(200);
  expect((await fetch(host.url + "/api/agents", { method: "HEAD" })).status).toBe(401);
});

test("authorization sees the inferred identity and request before runtime/SSE work", async () => {
  const model = new ScriptedProvider([{ text: "answer" }]);
  const agent = new Agent({ id: crypto.randomUUID(), model });
  host = await start({ agents: [agent], server: { auth: { provider, authorize: ({ user, request }) => {
    expectTypeOf(user).toEqualTypeOf<User>();
    return user.role === "admin" || request.method === "GET";
  } } } });
  const path = `/api/agents/${agent.id}/stream`;
  const response = await fetch(host.url + path, { method: "POST", headers: { "x-user": "alice", "content-type": "application/json" }, body: JSON.stringify({ input: "deny" }) });
  expect(response.status).toBe(403);
  expect(model.calls).toHaveLength(0);
  const allowed = await fetch(host.url + path, { method: "POST", headers: { "x-user": "admin", "content-type": "application/json" }, body: JSON.stringify({ input: "allow" }) });
  expect(allowed.status).toBe(200);
  expect(await allowed.text()).toContain('"status":"completed"');
});

test("middleware runs before auth; failed providers and invalid policy results fail closed", async () => {
  const authenticate = vi.fn().mockRejectedValue(new Error("identity unavailable"));
  host = await start({ server: { auth: { provider: { authenticate } }, middlewares: [registerMiddleware("*", async (c, next) => {
    if (c.req.header("x-block")) return c.text("blocked", 403);
    await next();
  })] } });
  expect((await fetch(host.url + "/api/agents", { headers: { "x-block": "yes" } })).status).toBe(403);
  expect(authenticate).not.toHaveBeenCalled();
  expect((await fetch(host.url + "/api/agents")).status).toBe(500);
});

test("invalid auth config is rejected without initializing controllers", async () => {
  const agent = new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([]) });
  const controller = new Controller({ id: crypto.randomUUID(), agent });
  try {
    expect(() => new Tessar({ controllers: [controller], server: { auth: {} as never } })).toThrow();
    expect(controller.isReady()).toBe(false);
  } finally { await controller.dispose(); }
});

test("unmatched requests do not restore sessions before authentication", async () => {
  const controller = new Controller({ id: "protected", agent: new Agent({ id: "protected-agent", model: new ScriptedProvider([]) }) });
  const restore = vi.spyOn(controller, "getSession");
  host = await start({ controllers: [controller], server: { auth: { provider } } });
  for (const [method, path] of [["OPTIONS", "/state"], ["GET", "/unknown"]]) {
    expect((await fetch(host.url + "/api/controllers/protected/sessions/missing" + path, { method })).status).toBe(404);
  }
  expect(restore).not.toHaveBeenCalled();
  expect((await fetch(host.url + "/api/controllers/protected/sessions/missing/state")).status).toBe(401);
  expect(restore).not.toHaveBeenCalled();
});

test("invalid identity, authorization and scope callback values never allow access", async () => {
  for (const policy of [
    { provider: { authenticate: async () => undefined } },
    { provider, authorize: () => "yes" },
    { provider, scope: () => ({ userId: undefined }) },
  ]) {
    host = await start({ server: { auth: policy as never } });
    expect((await fetch(host.url + "/api/agents", { headers: { "x-user": "alice" } })).status).toBe(500);
    await host.server.shutdown(); host = undefined;
  }
});

test("provider request-body inspection does not consume the runtime input", async () => {
  const model = new ScriptedProvider([{ text: "answer" }]);
  const agent = new Agent({ id: crypto.randomUUID(), model });
  host = await start({ agents: [agent], server: { auth: { provider: { authenticate: async request => {
    expect(await request.json()).toEqual({ input: "hello" });
    return { id: "alice" };
  } } } } });
  expect((await host.request(`/api/agents/${agent.id}/generate`, "POST", { input: "hello" })).status).toBe(200);
  expect(model.calls).toHaveLength(1);
});
