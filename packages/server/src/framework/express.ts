import type { Express, Request as ExpressRequest } from "express";
import { getRequestListener } from "@hono/node-server";
import { TessarServerAdapter } from "./server-adapter.js";
import type { TessarRequestHandler } from "../types.js";

export class TessarServer extends TessarServerAdapter<Express> {
  protected registerHandler(handler: TessarRequestHandler): void {
    const listener = getRequestListener((request, bindings) => {
      const incoming = bindings.incoming as ExpressRequest;
      const headers = new Headers(request.headers);
      let body: BodyInit | null = null;
      // express.json() has already consumed the native stream.
      if (incoming.body !== undefined && request.method !== "GET" && request.method !== "HEAD") {
        headers.delete("content-length");
        headers.delete("content-encoding");
        body = Buffer.isBuffer(incoming.body) ? new Uint8Array(incoming.body) : JSON.stringify(incoming.body);
      } else if (request.method !== "GET" && request.method !== "HEAD") body = request.body;
      return handler(new Request(request.url, {
        method: request.method, headers, body, signal: request.signal, duplex: "half",
      } as RequestInit));
    }, { overrideGlobalObjects: false });
    this.app.use((request, response, next) => {
      if (!this.accepts(new URL(request.url, "http://localhost").pathname)) return next();
      void listener(request, response).catch(next);
    });
  }
}
