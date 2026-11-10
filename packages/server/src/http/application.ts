import { Hono } from "hono";
import { TessarServerError } from "../errors.js";
import { registerMiddleware, registerRoute } from "./registration.js";
import { fields, invalid } from "../runtime/validation.js";
import { httpError, HTTP_ERROR_CODE, HTTP_ERROR_MESSAGE } from "./protocol.js";
import { registerControllers } from "./routes/controllers.js";
import { registerSessions } from "./routes/sessions.js";
import { registerThreads } from "./routes/threads.js";
import { registerRecords } from "./routes/records.js";
import { SseTransport } from "./sse.js";
import { registerAgents } from "./routes/agents.js";
import { registerState } from "./routes/state.js";
import { authenticate } from "./access.js";

const ROUTE_METHOD = { ALL: "ALL", HEAD: "HEAD", GET: "GET" } as const;

import type { RuntimeContext } from "../runtime/context.js";
import type { ServerOptions } from "../types.js";
import { openapiDocument } from "./openapi.js";

export class ServerApplication {
  readonly app: Hono;
  private readonly transport = new SseTransport();
  constructor(runtime: RuntimeContext, config: ServerOptions<any> = {}) {
    const app = new Hono();
    app.onError(httpError);
    app.notFound(c => httpError(new TessarServerError(HTTP_ERROR_CODE.NOT_FOUND, HTTP_ERROR_MESSAGE.NOT_FOUND), c));
    for (const middleware of config.middlewares ?? []) {
      fields(middleware, ["path", "handler"]);
      const entry = registerMiddleware(middleware.path, middleware.handler);
      app.use(entry.path, entry.handler);
    }
    let protectedRoutes: { method: string; pattern: RegExp }[] = [];
    if (config.auth) app.use("*", async (c, next) => {
      const method = c.req.method === ROUTE_METHOD.HEAD ? ROUTE_METHOD.GET : c.req.method;
      if (protectedRoutes.some(route => route.method === method && route.pattern.test(c.req.path)))
        await authenticate(c, config.auth!);
      await next();
    });
    registerAgents(app, () => runtime.registry, this.transport, runtime.hub);
    registerControllers(app, () => runtime.registry);
    registerSessions(app, () => runtime.registry, () => runtime.sessions);
    registerThreads(app, () => runtime.sessions);
    registerRecords(app, () => runtime.registry);
    registerState(app, () => runtime.sessions, runtime.hub, this.transport);
    protectedRoutes = app.routes.filter(route => route.method !== ROUTE_METHOD.ALL).map(route => ({
      method: route.method,
      pattern: new RegExp("^" + route.path.split("/").map(part => part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/") + "$"),
    }));
    const declarations = (config.routes ?? []).map(route => {
      fields(route, ["path", "method", "handler"]);
      return registerRoute(route.path, { method: route.method, handler: route.handler });
    });
    const seen = new Set(app.routes.map(route => `${route.method} ${route.path}`));
    for (const route of declarations) {
      const key = `${route.method} ${route.path}`;
      if (seen.has(key)) invalid("Duplicate route: " + key);
      seen.add(key);
      app.on(route.method, route.path, route.handler);
    }

    const routes = app.routes.filter(route => route.method !== ROUTE_METHOD.ALL);
    const openapiPath = config.openapiPath ?? "/openapi.json";
    if (routes.some(route => route.path === openapiPath)) invalid("OpenAPI path conflicts with an API route");
    const document = openapiDocument(routes, config.prefix ?? "");
    app.get(openapiPath, c => c.json(document));
    this.app = app;
  }
  shutdown(): void { this.transport.close(); }
}
