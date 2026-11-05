import { ServerApplication } from "../http/application.js";
import { runtimeFor } from "../runtime/context.js";
import { fields, invalid } from "../runtime/validation.js";
import { TessarServerError, SERVER_ERROR_CODE } from "../errors.js";
import type { Tessar } from "../tessar.js";
import type { TessarRequestHandler, TessarServerOptions } from "../types.js";

export abstract class TessarServerAdapter<App> {
  protected readonly app: App;
  protected readonly tessar: Tessar;
  private readonly prefix: string;
  private readonly openapiPath: string;
  private application?: ServerApplication;
  private initialization?: Promise<void>;
  private disposal?: Promise<void>;
  private closed = false;

  constructor(options: TessarServerOptions<App>) {
    fields(options, ["app", "tessar", "prefix", "openapiPath"]);
    if (!options?.app) invalid("An application is required");
    runtimeFor(options.tessar);
    this.app = options.app;
    this.tessar = options.tessar;
    this.prefix = options.prefix ?? options.tessar.server.prefix ?? "";
    this.openapiPath = options.openapiPath ?? options.tessar.server.openapiPath ?? "/openapi.json";
    for (const [name, path] of [["prefix", this.prefix], ["openapiPath", this.openapiPath]] as const) {
      if (name === "prefix" && path === "") continue;
      if (typeof path !== "string" || !/^\/(?:[A-Za-z0-9_.~-]+\/?)+$/.test(path) || path.endsWith("/") || path.split("/").some(part => part === "." || part === ".."))
        invalid(name + " must be an absolute path without a trailing slash, query or fragment");
    }
    if (this.openapiPath === "/api" || this.openapiPath.startsWith("/api/")) invalid("OpenAPI path must be outside /api");
  }

  protected abstract registerHandler(handler: TessarRequestHandler): void | Promise<void>;

  protected accepts(pathname: string): boolean {
    if (this.prefix && !pathname.startsWith(this.prefix + "/")) return false;
    const path = pathname.slice(this.prefix.length);
    return path === "/api" || path.startsWith("/api/") || path === this.openapiPath ||
      (this.tessar.server.routes ?? []).some(route => {
        const pattern = route.path.split("/").map(part => part === "*" ? ".*" : part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/");
        return new RegExp("^" + pattern + "$").test(path);
      });
  }

  init(): Promise<void> {
    if (this.closed) return Promise.reject(new TessarServerError(SERVER_ERROR_CODE.DISPOSED, "Server adapter is shut down"));
    return this.initialization ??= (async () => {
      try {
        await runtimeFor(this.tessar).ready();
        if (this.closed) throw new TessarServerError(SERVER_ERROR_CODE.DISPOSED, "Server adapter is shut down");
        const application = this.application = new ServerApplication(runtimeFor(this.tessar), {
          ...this.tessar.server, prefix: this.prefix, openapiPath: this.openapiPath,
        });
        await this.registerHandler(async request => {
          if (this.closed) return Response.json({ error: new TessarServerError(SERVER_ERROR_CODE.DISPOSED, "Server adapter is shut down").toJSON() }, { status: 503 });
          const url = new URL(request.url);
          if (this.prefix && !url.pathname.startsWith(this.prefix + "/")) return new Response(null, { status: 404 });
          url.pathname = url.pathname.slice(this.prefix.length);
          return application.app.fetch(new Request(url, request));
        });
        if (this.closed) throw new TessarServerError(SERVER_ERROR_CODE.DISPOSED, "Server adapter is shut down");
      } catch (error) {
        this.closed = true;
        this.application?.shutdown();
        throw error;
      }
    })();
  }

  shutdown(): Promise<void> {
    this.closed = true;
    return this.disposal ??= (async () => {
      await this.initialization?.catch(() => { });
      this.application?.shutdown();
    })();
  }
}
