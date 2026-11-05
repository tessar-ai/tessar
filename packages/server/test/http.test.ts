import { afterEach, expect, test } from "vitest";
import { start } from "./helpers.js";
import type { Tessar } from "../src/index.js";
import { Agent, Controller } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
let server: Tessar;
afterEach(async () => { await server?.shutdown(); });

test("Session and Thread routes retain SDK shapes and selection across HTTP requests", async () => {
  const host = await start(); server = host.server;
  const { request } = host;
  const { data: [agent] } = await request("/api/agents");
  const c = `/api/controllers/${agent.controllerId}`;
  const created = await request(c + "/sessions", "POST", { metadata: { tab: "one" } });
  expect(created.status).toBe(201);
  const s = c + "/sessions/" + created.data.id;
  const thread = await request(s + "/threads", "POST", { title: "Example" });
  expect(thread.status).toBe(201);
  expect((await request(s)).data.selectedThreadId).toBe(thread.data.id);
  expect((await request(s + "/threads")).data.items).toHaveLength(1);
  expect((await request(s + "/threads/" + thread.data.id + "/turns")).data).toEqual({ items: [], nextCursor: null });
  expect((await request(s + "/queue")).data).toEqual({ count: 0, isEmpty: true });
  expect((await request(s + "/close", "POST", {})).status).toBe(204);
  expect((await request(s)).data.selectedThreadId).toBe(thread.data.id);
  expect((await request(s + "/threads?limit=oops")).status).toBe(400);
  expect((await request(s + "/threads?cursor=oops")).status).toBe(400);
  expect((await request(c + "/sessions/missing")).status).toBe(404);
  expect((await request(c + "/sessions", "POST", { unknown: true })).status).toBe(400);
});

test("records append/get/list through the selected public store", async () => {
  const host = await start(); server = host.server;
  const { request } = host;
  const { data: [agent] } = await request("/api/agents");
  const path = `/api/controllers/${agent.controllerId}/records/notes`;
  const created = await request(path, "POST", { data: { text: "note" } });
  expect(created.status).toBe(201);
  expect((await request(path + "/" + created.data.id)).data).toEqual(created.data);
  expect((await request(path)).data.items).toEqual([created.data]);
  expect((await request(path + "/missing")).status).toBe(404);
});

test("malformed wire fields return 400 before persisting or executing", async () => {
  const host = await start(); server = host.server;
  const { data: [agent] } = await host.request("/api/agents");
  const c = `/api/controllers/${agent.controllerId}`;
  expect((await host.request(c + "/sessions", "POST", { metadata: "malformed" })).status).toBe(400);
  expect((await host.request(c + "/sessions")).data.items).toHaveLength(0);
  const { data: session } = await host.request(c + "/sessions", "POST", {});
  const s = c + "/sessions/" + session.id;
  expect((await host.request(s + "/threads", "POST", { messages: null })).status).toBe(400);
  expect((await host.request(s + "/threads")).data.items).toHaveLength(0);
  await host.request(s + "/threads", "POST", {});
  for (const [path, value] of [
    [`/api/agents/${agent.id}/generate`, { input: null }],
    [`/api/agents/${agent.id}/generate`, { input: "test", options: { context: null } }],
    [s + "/follow-up", { input: null }], [s + "/resume", {}], [s + "/recover", {}],
    [s + "/model/switch", { modelId: "test", options: [] }],
    [c + "/sessions", { model: "not-a-reference" }],
  ] as const) expect((await host.request(path, "POST", value)).status).toBe(400);
});

test("history accepts the public atCheckpointId selector and rejects invented query fields", async () => {
  const host = await start(); server = host.server;
  const { data: [agent] } = await host.request("/api/agents");
  const c = `/api/controllers/${agent.controllerId}`;
  const { data: session } = await host.request(c + "/sessions", "POST", {});
  const s = c + "/sessions/" + session.id;
  const { data: thread } = await host.request(s + "/threads", "POST", {});
  const t = s + "/threads/" + thread.id;
  const { data: initial } = await host.request(t + "/snapshot");
  await host.request(s + "/follow-up", "POST", { input: "hello" });
  await expect.poll(async () => (await host.request(s + "/state")).data.status).toBe("completed");
  const earlier = await host.request(t + "/history?atCheckpointId=" + initial.id);
  expect(earlier.status).toBe(200);
  expect(earlier.data.items).toHaveLength(0);
  expect((await host.request(t + "/history?pinnedPage=garbage")).status).toBe(400);
});

test("invalidated and explicitly closed Session subscriptions end, and reconnect restores current state", async () => {
  const controller = new Controller({ id: crypto.randomUUID(), agent: new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([]) }) });
  const host = await start({ agents: [], controllers: [controller] }); server = host.server;
  const c = `/api/controllers/${controller.id}`;
  const { data: session } = await host.request(c + "/sessions", "POST", {});
  const s = c + "/sessions/" + session.id;
  await host.request(s + "/threads", "POST", {});
  const reader = (await fetch(host.url + s + "/state/stream")).body!.getReader();
  await reader.read();
  const external = (await controller.getSession(session.id))!;
  const replacement = await external.thread.create();
  expect((await host.request(s + "/follow-up", "POST", { input: "stale" })).status).toBe(409);
  expect((await reader.read()).done).toBe(true);
  expect((await host.request(s)).data.selectedThreadId).toBe(replacement.id);
  const fresh = (await fetch(host.url + s + "/state/stream")).body!.getReader();
  expect(new TextDecoder().decode((await fresh.read()).value)).toContain(replacement.id);
  await host.request(s + "/close", "POST", {});
  let next = await fresh.read();
  while (!next.done) next = await fresh.read();
  expect(next.done).toBe(true);
  await external.dispose();
});
