import { HTTP_STATUS } from "./protocol.js";

type Schema = Record<string, unknown>;
const object: Schema = { type: "object", additionalProperties: true };
const string: Schema = { type: "string" };
const ref = (name: string): Schema => ({ $ref: "#/components/schemas/" + name });
const array = (items: Schema): Schema => ({ type: "array", items });
const shape = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: "object", properties, required, additionalProperties: false });

const schemas: Record<string, Schema> = {
  ModelRef: shape({ providerId: string, modelId: string, connectionId: string }, ["providerId", "modelId"]),
  Message: {
    type: "object", required: ["schemaVersion", "id", "role", "content"], properties: {
      schemaVersion: { const: 1 }, id: string, role: { enum: ["system", "user", "assistant", "tool"] }, content: array(object),
    }, additionalProperties: true
  },
  Input: { anyOf: [string, ref("Message"), array(ref("Message"))] },
  ErrorInfo: {
    type: "object", required: ["source", "name", "code", "message", "retryable"], properties: {
      source: { enum: ["tessar", "provider", "plugin", "tool", "storage", "application"] }, name: string, code: string,
      message: string, retryable: { type: "boolean" }, details: object,
    }, additionalProperties: true
  },
  Error: shape({ error: ref("ErrorInfo") }, ["error"]),
  Page: { type: "object", properties: { items: array(object), nextCursor: { type: ["string", "null"] } }, required: ["items"], additionalProperties: true },
  State: {
    type: "object", required: ["status", "messages"], properties: {
      status: string, messages: array(ref("Message")), currentMessage: { anyOf: [ref("Message"), { type: "null" }] },
      tools: array(object), queuedInputs: { type: "integer", minimum: 0 }, error: { anyOf: [ref("ErrorInfo"), { type: "null" }] },
    }, additionalProperties: true
  },
  Outcome: {
    type: "object", properties: {
      status: string, streamId: string, threadId: string, output: array(ref("Message")),
      error: { anyOf: [ref("ErrorInfo"), { type: "null" }] }
    }, required: ["status", "output"], additionalProperties: true
  },
};

function requestSchema(path: string): Schema | undefined {
  const scoped = { id: string, scope: object, metadata: object };
  if (/\/agents\/:agentId\/(generate|stream)$/.test(path)) return shape({
    input: ref("Input"), options: shape({
      id: string, model: { anyOf: [string, ref("ModelRef")] }, modelOptions: object, scope: object, context: object, limits: object,
    })
  }, ["input"]);
  if (/\/agents\/:agentId\/resume$/.test(path)) return shape({ threadId: string, interruptId: string, value: {}, scope: object }, ["threadId", "interruptId", "value"]);
  if (path.endsWith("/signals")) return shape({ streamId: string, threadId: string, content: {}, persist: { type: "boolean" }, tagName: string, attributes: object, metadata: object }, ["content"]);
  if (path.endsWith("/sessions")) return shape({ ...scoped, model: ref("ModelRef"), threadId: string });
  if (path.endsWith("/follow-up")) return shape({ input: ref("Input") }, ["input"]);
  if (path.endsWith("/resume")) return shape({ interruptId: string, value: {}, model: ref("ModelRef") }, ["interruptId", "value"]);
  if (path.endsWith("/recover")) return shape({ streamId: string, model: ref("ModelRef") }, ["streamId"]);
  if (path.endsWith("/abort")) return shape({ reason: string });
  if (path.endsWith("/model/switch")) return shape({ modelId: string, options: object }, ["modelId"]);
  if (path.endsWith("/model/effort")) return shape({ level: string }, ["level"]);
  if (path.endsWith("/threads")) return shape({ id: string, title: string, messages: array(ref("Message")), metadata: object });
  if (path.endsWith("/thread/switch")) return shape({ threadId: string }, ["threadId"]);
  if (path.endsWith("/rename")) return shape({ title: string }, ["title"]);
  if (path.endsWith("/fork")) return shape({ id: string, atCheckpointId: string, atMessageId: string, metadata: object });
  if (path.endsWith("/records/:namespace")) return shape({ id: string, scope: object, data: {} }, ["data"]);
  return undefined;
}

function success(path: string, method: string): { status: number; schema?: Schema; streaming?: boolean } {
  if (path.endsWith("/generate")) return { status: 200, schema: ref("Outcome") };
  if (path.endsWith("/state/stream") || /\/agents\/:agentId\/(stream|resume)$/.test(path)) return { status: 200, streaming: true };
  if (method === "DELETE" || /\/(close|abort|rename|purge|signals|model\/switch|model\/effort)$/.test(path)) return { status: 204 };
  if (method === "POST") return { status: /\/(follow-up|resume|recover)$/.test(path) ? 202 : /\/(sessions|threads|fork|records\/:namespace)$/.test(path) ? 201 : 200, schema: object };
  if (path.endsWith("/state")) return { status: 200, schema: ref("State") };
  if (/^\/api\/(agents|controllers)$/.test(path) || /\/(tools|models)$/.test(path)) return { status: 200, schema: array(object) };
  if (/\/(sessions|threads|history|checkpoints|streams|turns|model-attempts|tool-executions|interrupts|records\/:namespace)$/.test(path)) return { status: 200, schema: ref("Page") };
  return { status: 200, schema: object };
}

/** The router supplies paths/methods so endpoint additions cannot silently disappear from the document. */
export function openapiDocument(routes: readonly { path: string; method: string }[], prefix: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    if (!route.path.startsWith("/api/") && route.path !== "/api") continue;
    const path = prefix + route.path.replace(/:([A-Za-z]+)/g, "{$1}");
    const parameters: Record<string, unknown>[] = [...route.path.matchAll(/:([A-Za-z]+)/g)].map(match => ({ name: match[1], in: "path", required: true, schema: string }));
    if (route.method === "GET") {
      const paged = success(route.path, route.method).schema?.$ref === "#/components/schemas/Page";
      const query = [...(paged ? ["limit", "cursor"] : []),
      ...(/\/api\/controllers\/:controllerId\/(sessions|records\/:namespace(?:\/:recordId)?)$/.test(route.path) ? ["scope"] : []),
      ...(route.path.endsWith("/history") ? ["atCheckpointId"] : []),
      ...(/\/(streams|turns|model-attempts|tool-executions|interrupts)$/.test(route.path) ? ["status"] : [])];
      for (const name of query) parameters.push({
        name, in: "query", required: false, schema: name === "limit" ? { type: "integer", minimum: 1, maximum: 200 } : string,
        ...(name === "scope" ? { description: "JSON-encoded scope object" } : {})
      });
    }
    const result = success(route.path, route.method);
    const responses: Record<string, unknown> = {
      [result.status]: {
        description: result.streaming ? "SSE state_changed snapshots; disconnect detaches the viewer without aborting execution" : result.status === 204 ? "No content" : "Success",
        ...(result.streaming ? { content: { "text/event-stream": { schema: string } } } : result.schema ? { content: { "application/json": { schema: result.schema } } } : {})
      }
    };
    for (const [status, description] of [[HTTP_STATUS.BAD_REQUEST, "Invalid request"], [HTTP_STATUS.UNAUTHORIZED, "Authentication required"], [HTTP_STATUS.FORBIDDEN, "Request not permitted"], [HTTP_STATUS.NOT_FOUND, "Resource not found"], [HTTP_STATUS.CONFLICT, "State conflict"], [HTTP_STATUS.INTERNAL_SERVER_ERROR, "Unexpected error"], [HTTP_STATUS.BAD_GATEWAY, "Provider error"], [HTTP_STATUS.SERVICE_UNAVAILABLE, "Unavailable runtime or storage"]] as const)
      responses[status] = { description, content: { "application/json": { schema: ref("Error") } } };
    const body = route.method === "POST" ? requestSchema(route.path) : undefined;
    (paths[path] ??= {})[route.method.toLowerCase()] = {
      operationId: route.method.toLowerCase() + route.path.replace(/[^A-Za-z0-9]+/g, "_"), parameters,
      ...(body ? { requestBody: { required: true, content: { "application/json": { schema: body } } } } : {}), responses,
    };
  }
  return { openapi: "3.1.0", info: { title: "Tessar API", version: "0.1.0" }, paths, components: { schemas } };
}
