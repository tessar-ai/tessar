import { afterEach, expect, test } from "vitest";
import { Agent, Controller } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { start } from "./helpers.js";

let host: Awaited<ReturnType<typeof start>> | undefined;
afterEach(async () => { await host?.server.shutdown(); host = undefined; });
const auth = {
  provider: { async authenticate(request: Request) { const id = request.headers.get("x-user"); return id ? { id } : null; } },
  scope: (user: { id: string }) => ({ userId: user.id }),
};
async function request(user: string, path: string, method = "GET", body?: unknown) {
  const response = await fetch(host!.url + path, { method, headers: { "x-user": user, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: response.status === 204 ? undefined : await response.json() };
}
async function setup() {
  const agent = new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([{ text: "one" }, { text: "two" }]) });
  const controller = new Controller({ id: crypto.randomUUID(), agent });
  host = await start({ controllers: [controller], server: { auth } });
  return { path: `/api/controllers/${controller.id}`, controller, agent };
}

test("mandatory scope controls Session creation, filtered paging, cached and cold ID access", async () => {
  const { path } = await setup();
  const a = await request("alice", path + "/sessions", "POST", { scope: { project: "notes" } });
  expect(a.status).toBe(201);
  expect(a.data.scope).toEqual({ userId: "alice", project: "notes" });
  await request("bob", path + "/sessions", "POST", {});
  const listed = await request("bob", path + "/sessions?limit=1");
  expect(listed.data.items).toHaveLength(1);
  expect(listed.data.items[0].scope).toEqual({ userId: "bob" });
  const sessionPath = path + "/sessions/" + a.data.id;
  for (const suffix of ["", "/state", "/threads", "/state/stream"]) {
    const response = await fetch(host!.url + sessionPath + suffix, { headers: { "x-user": "bob" } });
    expect(response.status, suffix).toBe(404);
    await response.body?.cancel();
  }
  expect((await request("alice", sessionPath)).status).toBe(200);
  await request("alice", sessionPath + "/close", "POST", {});
  expect((await request("bob", sessionPath)).status).toBe(404);
  expect((await request("alice", sessionPath)).status).toBe(200);
  expect((await request("alice", path + "/sessions", "POST", { scope: { userId: "bob" } })).status).toBe(403);
  const forged = encodeURIComponent(JSON.stringify({ userId: "alice" }));
  expect((await request("bob", path + "/sessions?scope=" + forged)).status).toBe(403);
});

test("records cannot cross mandatory scope via IDs, lists or forged payloads", async () => {
  const { path } = await setup();
  const record = await request("alice", path + "/records/notes", "POST", { data: { secret: true } });
  expect(record.data.scope).toEqual({ userId: "alice" });
  expect((await request("bob", path + "/records/notes")).data.items).toEqual([]);
  expect((await request("bob", path + "/records/notes/" + record.data.id)).status).toBe(404);
  expect((await request("bob", path + "/records/notes", "POST", { scope: { userId: "alice" }, data: {} })).status).toBe(403);
});

test("Thread selection and writes inherit the authorized Session boundary", async () => {
  const { path } = await setup();
  const a = (await request("alice", path + "/sessions", "POST", {})).data;
  const b = (await request("bob", path + "/sessions", "POST", {})).data;
  const ap = path + "/sessions/" + a.id, bp = path + "/sessions/" + b.id;
  const thread = (await request("alice", ap + "/threads", "POST", {})).data;
  expect(thread.scope).toEqual({ userId: "alice" });
  expect((await request("bob", bp + "/thread/switch", "POST", { threadId: thread.id })).status).toBe(404);
  expect((await request("bob", bp + "/threads/" + thread.id + "/history")).status).toBe(404);
  expect((await request("bob", bp + "/threads/" + thread.id + "/rename", "POST", { title: "stolen" })).status).toBe(404);
});
