import { Hono } from "hono";
import { createAdaptorServer } from "@hono/node-server";
import type { Server } from "node:http";
import { fields, invalid, registerMiddleware, registerRoute } from "./registration.js";
import { RuntimeRegistry } from "./runtime/runtime-registry.js";
import { ObserverPlugin } from "./runtime/observer-plugin.js";
import { httpError, HTTP_STATUS, HTTP_ERROR_CODE, HTTP_ERROR_MESSAGE } from "./http.js";
import { SessionRegistry } from "./runtime/session-registry.js";
import { registerSessions } from "./routes/sessions.js";
import { registerThreads } from "./routes/threads.js";
import { registerRecords } from "./routes/records.js";
import { ThreadStateHub } from "./runtime/thread-state-hub.js";
import { SseTransport } from "./sse.js";
import { registerAgents } from "./routes/agents.js";
import { registerState } from "./routes/state.js";
import type { TessarOptions } from "./types.js";

export class Tessar {
  private readonly runtimes: RuntimeRegistry;
  private readonly bootstrap: Promise<void>;
  private listener?: Server;
  private closing = false;
  private disposal?: Promise<void>;
  private readonly sessions: SessionRegistry;
  private readonly hub = new ThreadStateHub();
  private readonly transport = new SseTransport();

  constructor(options: TessarOptions) {
    fields(options, ["agents", "controllers", "server"]);
    const config = options.server ?? {};
    fields(config, ["hostname", "port", "routes", "middlewares"]);
    const { hostname = "127.0.0.1", port = 3000 } = config;
    if (typeof hostname !== "string" || !hostname.trim() || !Number.isInteger(port) || port < 0 || port > 65535)
      invalid("Invalid listening address");
    for (const list of [options.agents, options.controllers, config.routes, config.middlewares])
      if (list !== undefined && !Array.isArray(list)) invalid("Expected registration array");
    const app = new Hono();
    app.onError(httpError);
    app.notFound(c => c.json({ error: { source: "tessar", name: "TessarError", code: HTTP_ERROR_CODE.NOT_FOUND, message: HTTP_ERROR_MESSAGE.NOT_FOUND, retryable: false } }, HTTP_STATUS.NOT_FOUND));
    for (const middleware of config.middlewares ?? []) {
      fields(middleware, ["path", "handler"]);
      const entry = registerMiddleware(middleware.path, middleware.handler);
      app.use(entry.path, entry.handler);
    }
    registerAgents(app, () => this.runtimes, this.transport);
    registerSessions(app, () => this.runtimes, () => this.sessions);
    registerThreads(app, () => this.sessions);
    registerRecords(app, () => this.runtimes);
    registerState(app, () => this.sessions, this.hub, this.transport);
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
    const runtimes = this.runtimes = new RuntimeRegistry(options);
    const hub = this.hub;
    this.sessions = new SessionRegistry(runtimes, (id, session) => hub.attach(id, session), session => hub.remove(session));
    this.bootstrap = (async () => {
      try {
        for (const controller of runtimes.controllers.values()) {
          await controller.initialize();
          if (this.closing) return;
          await controller.plugins.attach(new ObserverPlugin(store => runtimes.records.set(controller.id, store), event => hub.observe(event)));
        }
        if (this.closing) return;
        const listener = createAdaptorServer({ fetch: app.fetch });
        this.listener = listener as Server;
        await new Promise<void>((resolve, reject) => {
          listener.once("error", reject);
          listener.listen(port, hostname, () => {
            listener.off("error", reject);
            const address = listener.address();
            if (address && typeof address !== "string") console.log(`Tessar listening at http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${address.port}`);
            resolve();
          });
        });
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
        await runtimes.dispose().catch(cleanup => console.error(cleanup));
      }
    })();
  }

  close(): Promise<void> {
    this.closing = true;
    return this.disposal ??= (async () => {
      await this.bootstrap;
      this.transport.close();
      this.hub.close();
      const listener = this.listener;
      const stopped = listener?.listening ? new Promise<void>((resolve, reject) => {
        listener.close(error => error ? reject(error) : resolve());
        listener.closeAllConnections();
      }) : Promise.resolve();
      const results = await Promise.allSettled([stopped, this.runtimes.dispose()]);
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Server cleanup failed");
    })();
  }
}
