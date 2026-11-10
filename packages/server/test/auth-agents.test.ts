import { afterEach, expect, test, vi } from "vitest";
import { Agent, Controller, AssistantMessage, MessageCodec, createTool } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { z } from "zod";
import { start } from "./helpers.js";

let host: Awaited<ReturnType<typeof start>> | undefined;
afterEach(async () => { await host?.server.shutdown(); host = undefined; });
const auth = {
  provider: { async authenticate(request: Request) { const id = request.headers.get("x-user"); return id ? { id } : null; } },
  scope: (user: { id: string }) => ({ userId: user.id }),
};
function post(user: string, path: string, body: unknown) {
  return fetch(host!.url + path, { method: "POST", headers: { "x-user": user, "content-type": "application/json" }, body: JSON.stringify(body) });
}
function last(text: string) { return text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).at(-1)!; }

test("independent Agent controls cannot cross scope, including a supplied stream ID", async () => {
  const model = new ScriptedProvider([{ gate: new Promise<void>(() => { }), text: "later" }]);
  const agent = new Agent({ id: crypto.randomUUID(), model });
  host = await start({ agents: [agent], server: { auth } });
  const path = `/api/agents/${agent.id}`;
  const streaming = await post("alice", path + "/stream", { input: "work", options: { id: "known-stream" } });
  await expect.poll(() => model.calls.length).toBe(1);
  expect((await post("bob", path + "/signals", { streamId: "known-stream", content: "injected" })).status).toBe(404);
  expect((await post("bob", path + "/streams/known-stream/abort", {})).status).toBe(404);
  expect((await post("alice", path + "/signals", { streamId: "known-stream", content: "own" })).status).toBe(204);
  expect((await post("alice", path + "/streams/known-stream/abort", {})).status).toBe(204);
  await streaming.body?.cancel();
  expect((await post("alice", path + "/generate", { input: "forged", options: { scope: { userId: "bob" } } })).status).toBe(403);
});

test("suspended independent Agent retains owner scope across resume", async () => {
  const ask = createTool({ name: "ask", description: "Choose", schema: z.object({}), resumeSchema: z.string(), execute: (_, context) => context.suspend({ question: "Choose" }) });
  const model = new ScriptedProvider([{ response: { message: MessageCodec.encode(new AssistantMessage([{ type: "tool-call", name: "ask", toolCallId: "call", arguments: {} }])) } }, { text: "resumed" }]);
  const agent = new Agent({ id: crypto.randomUUID(), model, tools: { ask } });
  host = await start({ agents: [agent], server: { auth } });
  const path = `/api/agents/${agent.id}`;
  const event = last(await (await post("alice", path + "/stream", { input: "choose" })).text());
  expect(event.scope).toEqual({ userId: "alice" });
  const continuation = { threadId: event.threadId, interruptId: event.payload.state.interrupt.id, value: "yes" };
  expect((await post("bob", path + "/resume", continuation)).status).toBe(404);
  expect(model.calls).toHaveLength(1);
  const resumed = await post("alice", path + "/resume", continuation);
  expect(resumed.status).toBe(200);
  expect(last(await resumed.text()).payload.state.status).toBe("completed");
});

test("persisted Agent continuation checks scope before SSE without a selected Session", async () => {
  const ask = createTool({ name: "ask", description: "Choose", schema: z.object({}), resumeSchema: z.string(), execute: (_, context) => context.suspend({ question: "Choose" }) });
  const model = new ScriptedProvider([{ response: { message: MessageCodec.encode(new AssistantMessage([{ type: "tool-call", name: "ask", toolCallId: "persisted-call", arguments: {} }])) } }, { text: "resumed" }]);
  const agent = new Agent({ id: crypto.randomUUID(), model, tools: { ask } });
  const controller = new Controller({ id: crypto.randomUUID(), agent });
  await controller.initialize();
  const result = await agent.generate("choose", { scope: { userId: "alice" } });
  host = await start({ controllers: [controller], server: { auth } });
  const restore = vi.spyOn(controller, "getSession");
  const path = `/api/agents/${agent.id}`;
  const continuation = { threadId: result.threadId, interruptId: result.interrupt!.id, value: "yes" };
  expect((await post("bob", path + "/resume", continuation)).status).toBe(404);
  expect(model.calls).toHaveLength(1);
  const response = await post("alice", path + "/resume", continuation);
  expect(response.status).toBe(200);
  expect(last(await response.text()).payload.state.status).toBe("completed");
  expect(restore).not.toHaveBeenCalled();
});

test("idle Thread signals use core scope checks without restoring a Session", async () => {
  const model = new ScriptedProvider([{ text: "allowed" }]);
  const agent = new Agent({ id: crypto.randomUUID(), model });
  const controller = new Controller({ id: crypto.randomUUID(), agent });
  await controller.initialize();
  const session = await controller.createSession({ scope: { userId: "alice" } });
  const thread = await session.thread.create();
  host = await start({ controllers: [controller], server: { auth } });
  const restore = vi.spyOn(controller, "getSession");
  const path = `/api/agents/${agent.id}/signals`;
  expect((await post("bob", path, { threadId: thread.id, content: "foreign" })).status).toBe(404);
  expect(model.calls).toHaveLength(0);
  expect((await post("alice", path, { threadId: thread.id, content: "own" })).status).toBe(204);
  await expect.poll(() => model.calls.length).toBe(1);
  expect(restore).not.toHaveBeenCalled();
});
