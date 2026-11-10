import type { Hono } from "hono";
import { TessarServerAdapter } from "./server-adapter.js";
import type { TessarRequestHandler } from "../types.js";

export class TessarServer extends TessarServerAdapter<Hono> {
  protected registerHandler(handler: TessarRequestHandler): void {
    this.app.use("*", async (context, next) => {
      if (this.accepts(new URL(context.req.url).pathname)) return handler(context.req.raw);
      await next();
    });
  }
}
