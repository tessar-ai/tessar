import { afterEach, expect, test } from "vitest";
import { Hono } from "hono";
import { Agent, Controller, AssistantMessage, MessageCodec, createTool } from "@tessar/core";
import { z } from "zod";
import { ScriptedProvider } from "@tessar/core/testing";
import { Tessar } from "../src/index.js";
import { TessarServer } from "../src/framework/hono.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const agent = () => new Agent({ id: crypto.randomUUID(), model: new ScriptedProvider([{ text: "answer" }]) });

test("multiple independent Agents run without registering or creating Controllers", async () => {
  const researcher = agent(), coder = agent();
  const tessar = new Tessar({ agents: [researcher, coder] });
  cleanup.push(() => tessar.shutdown());
  expect(tessar.getAgent(researcher.id)).toBe(researcher);
  expect(tessar.getAgent(coder.id)).toBe(coder);
  expect(() => tessar.getController(researcher.id)).toThrow(expect.objectContaining({ code: "ControllerNotFound" }));
  const app = new Hono(), server = new TessarServer({ app, tessar });
  cleanup.push(() => server.shutdown()); await server.init();
  expect(await (await app.request("/api/controllers")).json()).toEqual([]);
  const listed = await (await app.request("/api/agents")).json();
  expect(listed.map((item: { id: string }) => item.id)).toEqual([researcher.id, coder.id]);
  expect(listed.every((item: object) => !Object.hasOwn(item, "controllerId"))).toBe(true);
  expect((await app.request(`/api/controllers/${researcher.id}/sessions`, { method: "POST", body: "{}" })).status).toBe(404);
  for (const value of [researcher, coder]) {
    const response = await app.request(`/api/agents/${value.id}/generate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "hello" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("completed");
  }
  await tessar.shutdown();
  await expect(researcher.generate("closed")).rejects.toMatchObject({ code: "Disposed" });
  await expect(coder.generate("closed")).rejects.toMatchObject({ code: "Disposed" });
});

test("explicit Controllers and independent Agents share lookup without changing core ownership", async () => {
  const researcher = agent(), assistant = agent();
  const support = new Controller({ id: crypto.randomUUID(), agent: assistant });
  const tessar = new Tessar({ agents: [researcher], controllers: [support] });
  cleanup.push(() => tessar.shutdown());
  expect(tessar.getAgent(assistant.id)).toBe(assistant);
  expect(tessar.getAgent(researcher.id)).toBe(researcher);
  expect(tessar.getController(support.id)).toBe(support);
  const app = new Hono(), server = new TessarServer({ app, tessar });
  cleanup.push(() => server.shutdown()); await server.init();
  const controllers = await (await app.request("/api/controllers")).json();
  expect(controllers.map((item: { id: string }) => item.id)).toEqual([support.id]);
  const descriptor = await (await app.request(`/api/agents/${assistant.id}`)).json();
  expect(descriptor.controllerId).toBe(support.id);
  const session = await support.createSession(); await session.thread.create();
  await session.followUp("hello");
  await expect.poll(() => session.isIdle()).toBe(true);
  expect(session.state.get().status).toBe("completed");
});

test("registering an Agent again through either array fails without disposing caller instances", async () => {
  const assistant = agent();
  const controller = new Controller({ id: crypto.randomUUID(), agent: assistant });
  cleanup.push(() => controller.dispose());
  expect(() => new Tessar({ agents: [assistant], controllers: [controller] })).toThrow();
  expect(() => new Tessar({ controllers: [controller, controller] })).toThrow();
  await controller.initialize();
  expect(controller.isReady()).toBe(true);
});

test("Agents registered by Controller plugins are not automatically exposed by Tessar", async () => {
  const assistant = agent(), researcher = agent();
  const controller = new Controller({
    id: crypto.randomUUID(), agent: assistant,
    plugins: [{ id: "subagents", setup(context) { context.agent.register(researcher); } }],
  });
  const tessar = new Tessar({ controllers: [controller] }); cleanup.push(() => tessar.shutdown());
  const app = new Hono(), server = new TessarServer({ app, tessar });
  cleanup.push(() => server.shutdown()); await server.init();
  expect(() => tessar.getAgent(researcher.id)).toThrow(expect.objectContaining({ code: "AgentNotFound" }));
  expect((await app.request(`/api/agents/${researcher.id}`)).status).toBe(404);
  expect((await researcher.generate("plugin delegation")).status).toBe("completed");
});

test("independent Agent HTTP streaming retains suspension and resume without a Controller", async () => {
  const ask = createTool({
    name: "ask", description: "Ask", schema: z.object({}), resumeSchema: z.string(),
    execute: (_, context) => context.suspend({ question: "Choose" }),
  });
  const model = new ScriptedProvider([{
    response: {
      message: MessageCodec.encode(new AssistantMessage([
        { type: "tool-call", name: "ask", toolCallId: "call", arguments: {} },
      ]))
    }
  }, { text: "resumed" }]);
  const assistant = new Agent({ id: crypto.randomUUID(), model, tools: { ask } });
  const tessar = new Tessar({ agents: [assistant] }); cleanup.push(() => tessar.shutdown());
  const app = new Hono(), server = new TessarServer({ app, tessar });
  cleanup.push(() => server.shutdown()); await server.init();
  const post = (path: string, body: unknown) => app.request(`/api/agents/${assistant.id}/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const frames = (text: string) => text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  const suspended = frames(await (await post("stream", { input: "ask" })).text()).at(-1)!;
  expect(suspended.payload.state.status).toBe("suspended");
  expect(suspended.controllerId).toBeUndefined();
  const resumed = frames(await (await post("resume", {
    threadId: suspended.threadId,
    interruptId: suspended.payload.state.interrupt.id, value: "chosen",
  })).text()).at(-1)!;
  expect(resumed.payload.state.status).toBe("completed");
  expect(JSON.stringify(resumed.payload.state.messages)).toContain("resumed");
  expect(await (await app.request("/api/controllers")).json()).toEqual([]);
  expect(model.calls).toHaveLength(2);
});
