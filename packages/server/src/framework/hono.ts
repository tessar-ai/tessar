import type { Hono } from "hono";
import { TessarServerAdapter } from "./server-adapter.js";
import type { TessarRequestHandler } from "../types.js";

const CONTENT_LENGTH = "content-length";
const CONTENT_ENCODING = "content-encoding";

export class TessarServer extends TessarServerAdapter<Hono> {
  protected registerHandler(handler: TessarRequestHandler): void {
    this.app.use("*", async (context, next) => {
      if (!this.accepts(new URL(context.req.url).pathname)) return next();
      const request = context.req.raw;
      if (!request.bodyUsed) return handler(request);
      // Hono can replay a body read and cached by application middleware.
      const headers = new Headers(request.headers);
      headers.delete(CONTENT_LENGTH);
      headers.delete(CONTENT_ENCODING);
      return handler(new Request(request.url, {
        method: request.method, headers, signal: request.signal, body: await context.req.arrayBuffer(),
      }));
    });
  }
}
