import { Hono, type Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { Scope } from "@tessar/core";
import { TessarServerError } from "../errors.js";
import { registerMiddleware, registerRoute } from "./registration.js";
import { fields, invalid } from "../runtime/validation.js";
import { httpError, readHonoJson, limitBody, HTTP_STATUS, HTTP_ERROR_CODE, HTTP_ERROR_MESSAGE } from "./protocol.js";
import { SSE_HEADERS, SseTransport } from "./sse.js";
import { endpoints, handleEndpoint } from "./endpoints.js";
import { DEFAULT_OPENAPI_PATH } from "./paths.js";
import { authenticate } from "./access.js";

const ROUTE_METHOD = { ALL: "ALL", HEAD: "HEAD", GET: "GET" } as const;
const AUTH_SCOPE_KEY = "tessar.auth.scope";
type ApplicationEnv = { Variables: { [AUTH_SCOPE_KEY]: Scope | undefined } };

import type { RuntimeContext } from "../runtime/context.js";
import type { ServerOptions } from "../types.js";
import { openapiDocument } from "./openapi.js";

export class ServerApplication {
  readonly app: Hono<ApplicationEnv>;
  private readonly transport = new SseTransport();
  constructor(runtime: RuntimeContext, config: ServerOptions<any> = {}) {
    const app = new Hono<ApplicationEnv>();
    app.use("*", (_c, next) => runtime.sessions.request(next));
    app.onError(httpError);
    app.notFound(c => httpError(new TessarServerError(HTTP_ERROR_CODE.NOT_FOUND, HTTP_ERROR_MESSAGE.NOT_FOUND), c));
    let protectedRoutes: { method: string; pattern: RegExp }[] = [];
    const builtIn = (c: Context) => {
      const method = c.req.method === ROUTE_METHOD.HEAD ? ROUTE_METHOD.GET : c.req.method;
      return protectedRoutes.some(route => route.method === method && route.pattern.test(c.req.path));
    };
    app.use("*", async (c, next) => {
      if (builtIn(c)) await limitBody(c);
      await next();
    });
    for (const middleware of config.middlewares ?? []) {
      fields(middleware, ["path", "handler"]);
      const entry = registerMiddleware(middleware.path, middleware.handler);
      app.use(entry.path, entry.handler);
    }
    if (config.auth) app.use("*", async (c, next) => {
      if (builtIn(c)) c.set(AUTH_SCOPE_KEY, await authenticate(c.req.raw, config.auth!));
      await next();
    });
    for (const endpoint of endpoints(runtime)) app.on(endpoint.method, endpoint.path, async c => {
      const result = await handleEndpoint(runtime, endpoint, {
        scope: c.get(AUTH_SCOPE_KEY), param: name => c.req.param(name),
        queries: () => c.req.queries(), readJson: () => readHonoJson(c),
      });
      if ("subscribe" in result) return c.body(this.transport.open(result.subscribe), HTTP_STATUS.OK, SSE_HEADERS);
      if (result.status === HTTP_STATUS.NO_CONTENT) return c.body(null, HTTP_STATUS.NO_CONTENT);
      return c.json(result.payload, result.status as Exclude<StatusCode, 101 | 204 | 205 | 304>);
    });
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
    const openapiPath = config.openapiPath ?? DEFAULT_OPENAPI_PATH;
    if (routes.some(route => route.path === openapiPath)) invalid("OpenAPI path conflicts with an API route");
    const document = openapiDocument(routes, config.prefix ?? "");
    app.get(openapiPath, c => c.json(document));
    this.app = app;
  }
  shutdown(): void { this.transport.close(); }
}
