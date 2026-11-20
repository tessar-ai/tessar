import { afterEach, expect, test } from "vitest";
import { Agent, Controller, createTool, AssistantMessage, MessageCodec } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { TessarClient, TessarClientError, type StateEvent, type StateStream } from "@tessar/client";
import { registerMiddleware } from "@tessar/server";
import { z } from "zod";
import { start } from "../../packages/server/test/helpers.js";

let server: Awaited<ReturnType<typeof start>>["server"] | undefined;
const observers: AbortController[] = [];
afterEach(async () => { for (const observer of observers.splice(0)) observer.abort(); await server?.shutdown(); server = undefined; });
function watch() { const control = new AbortController(); observers.push(control); return control; }
async function last(stream: StateStream): Promise<StateEvent> {
  let final: StateEvent | undefined;
  for await (const event of stream) final = event;
  if (!final) throw Error("No state received");
  return final;
}
async function completed(stream: StateStream): Promise<StateEvent> {
  for await (const event of stream) if (event.payload.state.status === "completed") return event;
  throw Error("Stream ended before completion");
}

test("client supports direct Agents without inventing Controllers and preserves execution errors as data", async () => {
  const model = new ScriptedProvider([{ text: "generated" }, { text: "streamed" }, { error: new Error("provider failed") }, { error: new Error("provider failed") }]);
  const agent = new Agent({ id: "direct", model });
  const host = await start({ agents: [agent] }); server = host.server;
  const client = new TessarClient({ baseURL: host.url });
  expect(await client.listControllers()).toEqual([]);
  expect((await client.listAgents())[0]).not.toHaveProperty("controllerId");
  expect((await client.getAgent("direct").generate("one")).status).toBe("completed");
  const result = await last(await client.getAgent("direct").stream("two"));
  expect(result.payload.state.status).toBe("completed");
  expect(JSON.stringify(result)).toContain("streamed");
  await expect(client.getAgent("direct").generate("three")).rejects.toMatchObject({ status: 502, remote: { source: "provider" } });
  const failed = await last(await client.getAgent("direct").stream("four"));
  expect(failed.payload.state.status).toBe("failed");
  expect(failed.payload.state.error?.source).toBe("provider");
  await expect(client.getAgent("missing").info()).rejects.toMatchObject({ status: 404, remote: { code: "NotFound" } });
});

test("client receives ConsumerTooSlow as a terminal state when the Agent iterator overflows", async () => {
  const agent = new Agent({ id: "overflow", model: new ScriptedProvider([{ text: "x".repeat(4 * 1024 * 1024 + 1024) }]) });
  const host = await start({ agents: [agent] }); server = host.server;
  const client = new TessarClient({ baseURL: host.url });
  const result = await last(await client.getAgent(agent.id).stream("question"));
  expect(result.payload.state).toMatchObject({ status: "failed", error: { code: "ConsumerTooSlow", source: "tessar" } });
});

test("prefixed server enforces headers on JSON and SSE", async () => {
  const host = await start({
    server: {
      prefix: "/tessar", middlewares: [registerMiddleware("*", async (c, next) => {
        if (c.req.header("authorization") !== "Bearer test") return c.json({ denied: true }, 401);
        await next();
      })]
    }
  }); server = host.server;
  const baseURL = host.url + "/tessar";
  await expect(new TessarClient({ baseURL }).listAgents()).rejects.toMatchObject({ status: 401 });
  const client = new TessarClient({ baseURL, headers: { authorization: "Bearer test" } });
  const [info] = await client.listAgents();
  expect((await last(await client.getAgent(info!.id).stream("hi"))).payload.state.status).toBe("completed");
});

test("eager state subscription, multiple turns, history/model/records and fresh client restoration", async () => {
  const model = new ScriptedProvider([{ text: "first" }, { text: "second" }]);
  const owned = new Agent({ id: "owned", model });
  const direct = new Agent({ id: "independent", model: new ScriptedProvider([]) });
  const host = await start({ agents: [direct], controllers: [new Controller({ id: "main", agent: owned })] }); server = host.server;
  const client = new TessarClient({ baseURL: host.url });
  expect(await client.listControllers()).toEqual([{ id: "main", agentId: "owned", ready: true }]);
  const controller = client.getController("main");
  const session = await controller.createSession({ metadata: { purpose: "test" } });
  const thread = await session.thread.create({ title: "Conversation" });
  expect((await session.info()).selectedThreadId).toBe(thread.id);
  const stream = await session.state.stream({ signal: watch().signal });
  // Deliberately send before iteration: opening the stream must already subscribe.
  expect((await session.followUp("first question")).threadId).toBe(thread.id);
  expect(JSON.stringify(await completed(stream))).toContain("first");
  expect((await session.model.info()).name).toBe("test");
  const [selected] = await session.model.list();
  await session.model.switch(selected!.id);
  const second = await session.state.stream({ signal: watch().signal });
  // Consume the previous terminal snapshot before asking for the next turn.
  const iterator = second[Symbol.asyncIterator]();
  expect((await iterator.next()).value?.payload.state.status).toBe("completed");
  await session.followUp("second question");
  let found = false;
  while (!found) {
    const next = await iterator.next();
    if (next.done) throw Error("Unexpected observation EOF");
    found = next.value.payload.state.status === "completed" && JSON.stringify(next.value).includes("second");
  }
  await iterator.return!();
  expect(model.calls).toHaveLength(2);
  expect((await thread.getHistory()).items).toHaveLength(4);
  expect((await thread.listStreams()).items).toHaveLength(2);
  expect((await thread.listTurns()).items).toHaveLength(2);
  expect((await thread.listModelAttempts()).items).toHaveLength(2);
  expect((await thread.listToolExecutions()).items).toHaveLength(0);
  expect((await thread.listInterrupts()).items).toHaveLength(0);
  expect((await thread.snapshot()).id).toBeTruthy();
  expect((await thread.listCheckpoints()).items.length).toBeGreaterThan(0);
  const record = await controller.records.append({ namespace: "notes", data: { saved: true } });
  expect((await controller.records.get("notes", record.id)).data).toEqual({ saved: true });
  expect((await controller.records.list({ namespace: "notes" })).items).toHaveLength(1);
  const fresh = new TessarClient({ baseURL: host.url }).getController("main").getSession(session.id);
  expect((await fresh.info()).selectedThreadId).toBe(thread.id);
  expect(JSON.stringify(await completed(await fresh.state.stream({ signal: watch().signal })))).toContain("second");
  expect(model.calls).toHaveLength(2);
  await session.close();
});

test("disconnect and cancellation before iteration do not abort execution; viewers and selections stay independent", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const model = new ScriptedProvider([{ text: "finished despite disconnect", gate }]);
  const agent = new Agent({ id: "worker", model });
  const host = await start({ controllers: [new Controller({ id: "main", agent })] }); server = host.server;
  const controller = new TessarClient({ baseURL: host.url }).getController("main");
  const a = await controller.createSession(), b = await controller.createSession();
  const thread = await a.thread.create();
  await b.thread.switch(thread.id);
  const disconnected = watch();
  await a.state.stream({ signal: disconnected.signal });
  disconnected.abort();
  const viewer = await b.state.stream({ signal: watch().signal });
  await a.followUp("work");
  await expect.poll(() => model.calls.length).toBe(1);
  expect((await a.state.get()).status).toBe("running");
  release();
  expect(JSON.stringify(await completed(viewer))).toContain("finished despite disconnect");
  const other = await a.thread.create();
  expect(other.id).not.toBe(thread.id);
  expect((await b.info()).selectedThreadId).toBe(thread.id);
  expect((await a.info()).selectedThreadId).toBe(other.id);
});

test("independent Agent suspension/resume uses existing interrupt contract", async () => {
  const ask = createTool({ name: "ask", description: "Choose", schema: z.object({}), resumeSchema: z.string(), execute: (_, context) => context.suspend({ question: "Choose" }) });
  const model = new ScriptedProvider([{ response: { message: MessageCodec.encode(new AssistantMessage([{ type: "tool-call", name: "ask", toolCallId: "call", arguments: {} }])) } }, { text: "resumed" }]);
  const host = await start({ agents: [new Agent({ id: "ask", model, tools: { ask } })] }); server = host.server;
  const agent = new TessarClient({ baseURL: host.url }).getAgent("ask");
  const suspended = await last(await agent.stream("ask"));
  expect(suspended.payload.state.status).toBe("suspended");
  const resumed = await last(await agent.resume({ threadId: suspended.threadId!, interruptId: suspended.payload.state.interrupt!.id, value: "yes" }));
  expect(resumed.payload.state.status).toBe("completed");
  expect(model.calls).toHaveLength(2);
});

test("explicit Session abort is separate from disconnect", async () => {
  const model = new ScriptedProvider([{ gate: new Promise<void>(() => { }), text: "never" }]);
  const host = await start({ controllers: [new Controller({ id: "main", agent: new Agent({ id: "worker", model }) })] }); server = host.server;
  const session = await new TessarClient({ baseURL: host.url }).getController("main").createSession();
  await session.thread.create();
  await session.followUp("work");
  await expect.poll(() => model.calls.length).toBe(1);
  await session.abort({ reason: "stop" });
  await expect.poll(async () => (await session.state.get()).status).not.toBe("running");
  expect(await session.queue.info()).toEqual({ count: 0, isEmpty: true });
  await expect(session.model.setEffort("unknown")).rejects.toBeInstanceOf(TessarClientError);
});
