import { EventEnvelope, stateChanged, stream as streamEvents, errorInfo, errorFromInfo, type Scope, type Stream, type StreamEvent } from "@tessar/core";
import type { Context, Hono } from "hono";
import { agentDescriptor } from "../descriptors.js";
import { body, required, bad, safeError, validateFields, ROUTE_PARAM, HTTP_ERROR_MESSAGE, HTTP_STATUS, wireModel } from "../protocol.js";
import type { RuntimeRegistry } from "../../runtime/runtime-registry.js";
import type { SseTransport, StateEvent } from "../sse.js";
import type { ThreadStateHub } from "../../runtime/thread-state-hub.js";
import { authScope, scoped, visible } from "../access.js";

const AGENTS_PATH = "/api/agents";
const AGENT_PATH = AGENTS_PATH + "/:agentId";
export function registerAgents(app: Hono, runtimes: () => RuntimeRegistry, transport: SseTransport, hub: ThreadStateHub) {
  const getAgent = (c: Context) => required(runtimes().agents.get(c.req.param(ROUTE_PARAM.AGENT_ID)!));
  const active = new Map<string, { stream: Stream; scope: Scope }>();
  const streamKey = (agentId: string, streamId: string) => JSON.stringify([agentId, streamId]);
  app.get(AGENTS_PATH, c => c.json([...runtimes().agents.values()].map(agent => agentDescriptor(agent, runtimes().agentControllers.get(agent.id)))));
  app.get(AGENT_PATH, c => c.json(agentDescriptor(getAgent(c), runtimes().agentControllers.get(getAgent(c).id))));
  app.get(AGENT_PATH + "/tools", c => c.json(getAgent(c).listTool().map(tool => ({
    name: tool.name, description: tool.description, inputSchema: tool.jsonSchema,
  }))));
  app.post(AGENT_PATH + "/generate", async c => {
    const { input, options } = await executionBody(c);
    const agent = getAgent(c);
    const result = await agent.generate(input, options);
    return c.json({ ...result, error: safeError(result.error) });
  });
  const deliver = (c: Context, stream: Stream, agentId: string, scope: Scope = {}, events: AsyncIterable<StreamEvent> = stream): Response => transport.response(c, (push, end) => {
    let viewer: ((event: StateEvent) => void) | undefined = push;
    let last: StateEvent | undefined;
    let key: string | undefined;
    void (async () => {
      try {
        for await (const event of events) {
          hub.observe(event);
          if (stream.id && !key) { key = streamKey(agentId, stream.id); active.set(key, { stream, scope }); }
          if (event.type === stateChanged) { last = event as StateEvent; viewer?.(last); }
        }
      } catch (error) {
        console.error(error);
        if (last) viewer?.(new EventEnvelope(stateChanged, { state: { ...last.payload.state, status: "failed", error: errorInfo(error) } }, last));
      } finally {
        if (key && active.get(key)?.stream === stream) active.delete(key);
        end();
      }
    })();
    return () => { viewer = undefined; };
  });
  app.post(AGENT_PATH + "/stream", async c => {
    const { input, options } = await executionBody(c);
    const agent = getAgent(c);
    return deliver(c, agent.stream(input, options), agent.id, options.scope);
  });
  app.post(AGENT_PATH + "/resume", async c => {
    const value = await body(c, ["threadId", "interruptId", "value", "scope"]);
    if (!value.threadId || !value.interruptId || !("value" in value)) bad(HTTP_ERROR_MESSAGE.CONTINUATION_REQUIRED);
    const agent = getAgent(c);
    value.scope = scoped(c, value.scope);
    const stream = agent.resume(value as Parameters<typeof agent.resume>[0]);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (!first.done && first.value.type === streamEvents.error) {
      await iterator.return?.();
      throw errorFromInfo(first.value.payload.error);
    }
    const events = { async *[Symbol.asyncIterator]() {
      if (!first.done) yield first.value;
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) yield next.value;
    } };
    return deliver(c, stream, agent.id, value.scope, events);
  });
  app.post(AGENT_PATH + "/signals", async c => {
    const value = await body(c, ["streamId", "threadId", "content", "persist", "tagName", "attributes", "metadata"]);
    const agent = getAgent(c);
    value.scope = authScope(c);
    await agent.sendSignal(value as Parameters<typeof agent.sendSignal>[0]); return c.body(null, HTTP_STATUS.NO_CONTENT);
  });
  app.post(AGENT_PATH + "/streams/:streamId/abort", async c => {
    const { reason } = await body(c, ["reason"]);
    if (reason !== undefined && typeof reason !== "string") bad(HTTP_ERROR_MESSAGE.REASON_MUST_BE_STRING);
    const agent = getAgent(c), streamId = c.req.param(ROUTE_PARAM.STREAM_ID)!;
    const entry = required(active.get(streamKey(agent.id, streamId)));
    required(visible(entry.scope, authScope(c)) ? entry : undefined).stream.abort(reason);
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
  const options = value.options ?? {};
  options.scope = scoped(c, options.scope);
  options.id ??= crypto.randomUUID();
  return { input: value.input, options };
}
