import { expect, test } from "vitest";
import { Hono } from "hono";
import { registerAgents } from "../src/http/routes/agents.js";
import { registerControllers } from "../src/http/routes/controllers.js";
import { registerSessions } from "../src/http/routes/sessions.js";
import { registerThreads } from "../src/http/routes/threads.js";
import { registerRecords } from "../src/http/routes/records.js";
import { registerState } from "../src/http/routes/state.js";
import { ThreadStateHub } from "../src/runtime/thread-state-hub.js";
import { SseTransport } from "../src/http/sse.js";
import { openapiDocument } from "../src/http/openapi.js";

test("route inventory covers the reviewed public SDK runtime surface", () => {
  const app = new Hono(), transport = new SseTransport();
  const unused = (): never => { throw Error("Registration must not read runtimes"); };
  registerAgents(app, unused, transport, new ThreadStateHub()); registerControllers(app, unused); registerSessions(app, unused, unused);
  registerThreads(app, unused); registerRecords(app, unused);
  registerState(app, unused, new ThreadStateHub(), transport);
  const a = "/api/agents/:agentId";
  const CONTROLLER_PATH = "/api/controllers/:controllerId";
  const SESSION_PATH = CONTROLLER_PATH + "/sessions/:sessionId";
  const THREAD_PATH = SESSION_PATH + "/threads/:threadId";
  const expected = [
    "GET /api/agents", `GET ${a}`, `GET ${a}/tools`, ...["generate", "stream", "resume", "signals", "streams/:streamId/abort"].map(path => `POST ${a}/${path}`),
    "GET /api/controllers", `GET ${CONTROLLER_PATH}`, `GET ${CONTROLLER_PATH}/sessions`, `POST ${CONTROLLER_PATH}/sessions`, `GET ${SESSION_PATH}`,
    ...["close", "follow-up", "resume", "recover", "abort", "model/switch", "model/effort", "thread/switch", "threads"].map(path => `POST ${SESSION_PATH}/${path}`),
    ...["queue", "model", "models", "threads", "state", "state/stream"].map(path => `GET ${SESSION_PATH}/${path}`),
    `GET ${THREAD_PATH}`, `DELETE ${THREAD_PATH}`, ...["rename", "fork", "purge"].map(path => `POST ${THREAD_PATH}/${path}`),
    ...["snapshot", "history", "checkpoints", "checkpoints/:checkpointId", "streams", "streams/:streamId", "turns", "model-attempts", "tool-executions", "interrupts", "interrupts/:interruptId"].map(path => `GET ${THREAD_PATH}/${path}`),
    `POST ${CONTROLLER_PATH}/records/:namespace`, `GET ${CONTROLLER_PATH}/records/:namespace`, `GET ${CONTROLLER_PATH}/records/:namespace/:recordId`,
  ];
  expect(app.routes.filter(route => route.method !== "ALL").map(route => `${route.method} ${route.path}`).sort()).toEqual(expected.sort());
  const document = openapiDocument(app.routes.filter(route => route.method !== "ALL"), "/tessar");
  const documented = Object.entries(document.paths).flatMap(([path, methods]) => Object.keys(methods)
    .map(method => `${method.toUpperCase()} ${path.replace(/^\/tessar/, "").replace(/\{([^}]+)\}/g, ":$1")}`));
  expect(documented.sort()).toEqual(expected.sort());
  const signals = document.paths["/tessar/api/agents/{agentId}/signals"]!.post as { responses: Record<string, unknown> };
  expect(signals.responses["204"]).toEqual({ description: "No content" });
  const records = document.paths["/tessar/api/controllers/{controllerId}/records/{namespace}"]!.post as {
    requestBody: { content: { "application/json": { schema: { required: string[] } } } };
  };
  expect(records.requestBody.content["application/json"].schema.required).toContain("data");
});
