import { ServerApplication } from "../http/application.js";
import { HTTP_STATUS } from "../http/protocol.js";
import { runtimeFor } from "../runtime/context.js";
import type { TessarRequestHandler } from "../types.js";
import { ServerAdapter } from "./adapter.js";

export abstract class TessarServerAdapter<App> extends ServerAdapter<App> {
  private application?: ServerApplication;

  protected abstract registerHandler(handler: TessarRequestHandler): void | Promise<void>;

  protected accepts(pathname: string): boolean {
    if (this.prefix && !pathname.startsWith(this.prefix + "/")) return false;
    const path = pathname.slice(this.prefix.length);
    return path === "/api" || path.startsWith("/api/") || path === this.openapiPath;
  }

  protected mount(): void | Promise<void> {
    const application = this.application = new ServerApplication(runtimeFor(this.tessar), {
      ...this.tessar.server, prefix: this.prefix, openapiPath: this.openapiPath,
    });
    return this.registerHandler(async request => {
      if (this.closed) return Response.json({ error: this.disposed().toJSON() }, { status: HTTP_STATUS.SERVICE_UNAVAILABLE });
      const url = new URL(request.url);
      if (this.prefix && !url.pathname.startsWith(this.prefix + "/")) return new Response(null, { status: HTTP_STATUS.NOT_FOUND });
      url.pathname = url.pathname.slice(this.prefix.length);
      return application.fetch(new Request(url, request));
    });
  }

  protected closeTransport(): void { this.application?.shutdown(); }
}
