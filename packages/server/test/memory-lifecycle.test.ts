import { expect, test, vi } from "vitest";
import { Agent, Controller, defineInterruption, ToolDecision, stream, type Plugin, type Session } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { Tessar } from "../src/index.js";
import { runtimeFor } from "../src/runtime/context.js";
import { ServerApplication } from "../src/http/application.js";

async function host(model = new ScriptedProvider([]), plugins: Plugin[] = []) {
  const controller = new Controller({ id: crypto.randomUUID(), agent: new Agent({ id: crypto.randomUUID(), model }), plugins });
  const handles = new Map<string, Session>();
  const create = controller.createSession.bind(controller);
  vi.spyOn(controller, "createSession").mockImplementation(async options => {
    const session = await create(options); handles.set(session.id, session); return session;
  });
  const tessar = new Tessar({ controllers: [controller] });
  await runtimeFor(tessar).ready();
  const application = new ServerApplication(runtimeFor(tessar));
  const request = (path: string, init?: RequestInit) => application.fetch(new Request("http://test" + path, init));
  const base = "/api/controllers/" + controller.id + "/sessions";
  return {
    tessar, controller, handles, request, base,
    async create(options: Record<string, unknown> = {}) {
      const response = await request(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: crypto.randomUUID(), ...options }) });
      expect(response.status).toBe(201);
      const data = await response.json() as { id: string };
      return handles.get(data.id)!;
    },
    async close() { application.shutdown(); await tessar.shutdown(); },
  };
}

test("evicts old idle handles while preserving stored Session selection", async () => {
  const h = await host();
  try {
    const first = await h.create(); const selected = first.thread.getId();
    for (let index = 0; index < 100; index++) await h.create();
    expect(first.isDisposed()).toBe(true);
    const response = await h.request(h.base + "/" + first.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ selectedThreadId: selected, disposed: false });
  } finally { await h.close(); }
});

test("also bounds idle cache bytes when the number of handles is small", async () => {
  const h = await host();
  try {
    const large = await h.create({ metadata: { padding: "x".repeat(9 * 1024 * 1024) } });
    expect(large.isDisposed()).toBe(true);
    expect((await h.controller.listSessions()).items).toHaveLength(1);
  } finally { await h.close(); }
});

test("keeps pending interruptions available through cache pressure", async () => {
  const pause = defineInterruption({
    id: "pause", version: 1,
    response: { jsonSchema: { type: "boolean" }, parse: value => value }, resolve: () => ToolDecision.allow(),
  });
  let first = true;
  const h = await host(new ScriptedProvider([{ text: "done" }]), [{
    id: "pause", setup(p) {
      p.interruptions.register(pause);
      p.hook(stream.before, (_, context) => { if (first) { first = false; return context.suspend(pause, {}); } return ToolDecision.allow(); });
    }
  }]);
  try {
    const session = await h.create();
    await h.request(h.base + "/" + session.id + "/follow-up", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "pause" }),
    });
    await vi.waitFor(() => expect(session.state.get().status).toBe("suspended"));
    for (let index = 0; index < 100; index++) await h.create();
    expect(session.isDisposed()).toBe(false);
    const result = await h.request(h.base + "/" + session.id + "/resume", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ interruptId: session.state.get().interrupt!.id, value: true }),
    });
    expect(result.status).toBe(202);
  } finally { await h.close(); }
});

test("keeps a Session pinned until its HTTP handler finishes", async () => {
  const h = await host();
  const reached = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>();
  try {
    const first = await h.create();
    const read = first.thread.list;
    vi.spyOn(first.thread, "list").mockImplementation(async options => { reached.resolve(); await gate.promise; return read(options); });
    const request = h.request(h.base + "/" + first.id + "/threads");
    await reached.promise;
    for (let index = 0; index < 101; index++) await h.create();
    expect(first.isDisposed()).toBe(false);
    gate.resolve(); expect((await request).status).toBe(200);
  } finally { gate.resolve(); await h.close(); }
});

test("does not evict SSE viewers and permits eviction after disconnection", async () => {
  const h = await host();
  let response: Response | undefined;
  try {
    const first = await h.create();
    response = await h.request(h.base + "/" + first.id + "/state/stream");
    expect(response.status).toBe(200);
    for (let index = 0; index < 101; index++) await h.create();
    expect(first.isDisposed()).toBe(false);
    await response.body!.cancel();
    await h.create();
    expect(first.isDisposed()).toBe(true);
  } finally { await response?.body?.cancel().catch(() => { }); await h.close(); }
});

test("opens Session SSE with one selected Thread lookup", async () => {
  const h = await host();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const session = await h.create();
    const get = vi.spyOn(session.thread, "get");
    const response = await h.request(h.base + "/" + session.id + "/state/stream");
    expect(response.status).toBe(200);
    reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(get).toHaveBeenCalledOnce();
  } finally { await reader?.cancel(); await h.close(); }
});

test("evicts a completed Session only after its active work ends", async () => {
  const gate = Promise.withResolvers<void>();
  const model = new ScriptedProvider([{ text: "done", gate: gate.promise }]);
  const h = await host(model);
  try {
    const first = await h.create();
    await h.request(h.base + "/" + first.id + "/follow-up", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "work" }),
    });
    await vi.waitFor(() => expect(model.calls).toHaveLength(1));
    for (let index = 0; index < 100; index++) await h.create();
    expect(first.isDisposed()).toBe(false);
    gate.resolve();
    await vi.waitFor(() => expect(first.isDisposed()).toBe(true));
  } finally { gate.resolve(); await h.close(); }
});

test("shutdown releases cached handles even when Tessar remains referenced", async () => {
  const h = await host();
  const session = await h.create();
  const runtime = runtimeFor(h.tessar);
  const caches = [Reflect.get(runtime.sessions, "sessions"), Reflect.get(runtime.hub, "sessions")];
  for (const cache of caches) expect(cache.size).toBe(1);
  await h.close();
  expect(session.isDisposed()).toBe(true);
  for (const cache of caches) expect(cache.size).toBe(0);
  expect(h.tessar.getController(h.controller.id)).toBe(h.controller);
});

test("Tessar shutdown ends Session viewers before the HTTP adapter shuts down", async () => {
  const h = await host();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const session = await h.create();
    const response = await h.request(h.base + "/" + session.id + "/state/stream");
    reader = response.body!.getReader(); await reader.read();
    await h.tessar.shutdown();
    let ended = false;
    const done = reader.read().then(result => { ended = result.done; });
    try { await vi.waitFor(() => expect(ended).toBe(true)); }
    finally { await reader.cancel(); await done; }
  } finally { await reader?.cancel().catch(() => { }); await h.close(); }
});
