import { EventEnvelope, stateChanged, errorInfo, type Stream } from "@tessar/core";
import type { Context, Hono } from "hono";
import { agentDescriptor, controllerDescriptor } from "../descriptors.js";
import { body, required, bad, safeError, validateFields, ROUTE_PARAM, HTTP_ERROR_MESSAGE, HTTP_STATUS } from "../protocol.js";
import type { RuntimeRegistry } from "../../runtime/runtime-registry.js";
import type { SseTransport, StateEvent } from "../sse.js";
import { C, wireModel } from "./sessions.js";
import type { ThreadStateHub } from "../../runtime/thread-state-hub.js";

const A = "/api/agents/:agentId";
export function registerAgents(app: Hono, runtimes: () => RuntimeRegistry, transport: SseTransport, hub: ThreadStateHub) {
  const controller = (c: Context) => required([...runtimes().controllers.values()].find(value => value.agent.id === c.req.param(ROUTE_PARAM.AGENT_ID)));
  const active = new Map<string, Stream>();
  const streamKey = (agentId: string, streamId: string) => JSON.stringify([agentId, streamId]);
  app.get("/api/agents", c => c.json([...runtimes().controllers.values()].map(agentDescriptor)));
  app.get(A, c => c.json(agentDescriptor(controller(c))));
  app.get(A + "/tools", c => c.json(controller(c).agent.listTool().map(tool => ({
    name: tool.name, description: tool.description, inputSchema: tool.jsonSchema,
  }))));
  app.get("/api/controllers", c => c.json([...runtimes().controllers.values()].map(controllerDescriptor)));
  app.get(C, c => c.json(controllerDescriptor(required(runtimes().controllers.get(c.req.param(ROUTE_PARAM.CONTROLLER_ID)!)))));
  app.post(A + "/generate", async c => {
    const { input, options } = await executionBody(c);
    const result = await controller(c).agent.generate(input, options);
    return c.json({ ...result, error: safeError(result.error) });
  });
  const deliver = (c: Context, stream: Stream, agentId: string): Response => transport.response(c, (push, end) => {
    let viewer: ((event: StateEvent) => void) | undefined = push;
    let last: StateEvent | undefined;
    let key: string | undefined;
    void (async () => {
      try {
        for await (const event of stream) {
          hub.observe(event);
          if (stream.id && !key) { key = streamKey(agentId, stream.id); active.set(key, stream); }
          if (event.type === stateChanged) { last = event as StateEvent; viewer?.(last); }
        }
      } catch (error) {
        console.error(error);
        if (last) viewer?.(new EventEnvelope(stateChanged, { state: { ...last.payload.state, status: "failed", error: errorInfo(error) } }, last));
      } finally { if (key) active.delete(key); end(); }
    })();
    return () => { viewer = undefined; };
  });
  app.post(A + "/stream", async c => {
    const { input, options } = await executionBody(c);
    const agent = controller(c).agent;
    return deliver(c, agent.stream(input, options), agent.id);
  });
  app.post(A + "/resume", async c => {
    const value = await body(c, ["threadId", "interruptId", "value", "scope"]);
    if (!value.threadId || !value.interruptId || !("value" in value)) bad(HTTP_ERROR_MESSAGE.CONTINUATION_REQUIRED);
    const agent = controller(c).agent;
    return deliver(c, agent.resume(value as Parameters<typeof agent.resume>[0]), agent.id);
  });
  app.post(A + "/signals", async c => {
    const value = await body(c, ["streamId", "threadId", "content", "persist", "tagName", "attributes", "metadata"]);
    const agent = controller(c).agent;
    await agent.sendSignal(value as Parameters<typeof agent.sendSignal>[0]); return c.body(null, HTTP_STATUS.NO_CONTENT);
  });
  app.post(A + "/streams/:streamId/abort", async c => {
    const { reason } = await body(c, ["reason"]);
    if (reason !== undefined && typeof reason !== "string") bad(HTTP_ERROR_MESSAGE.REASON_MUST_BE_STRING);
    required(active.get(streamKey(controller(c).agent.id, c.req.param(ROUTE_PARAM.STREAM_ID)!))).abort(reason);
    return c.body(null, HTTP_STATUS.NO_CONTENT);
  });
}

async function executionBody(c: Context) {
  const value = await body(c, ["input", "options"]);
  if (value.input === undefined) bad(HTTP_ERROR_MESSAGE.INPUT_REQUIRED);
  if (value.options !== undefined) {
    if (!value.options || typeof value.options !== "object" || Array.isArray(value.options) ||
      Object.keys(value.options).some(key => !["model", "modelOptions", "scope", "context", "limits", "id"].includes(key))) bad("Invalid execution options");
    wireModel(value.options.model, true);
    validateFields(value.options);
  }
  return value;
}
