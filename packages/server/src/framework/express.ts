import type { Express, Request as ExpressRequest, Response as ExpressResponse } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { TessarServerAdapter } from "./server-adapter.js";
import type { TessarRequestHandler } from "../types.js";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const CONTENT_LENGTH = "content-length";
const CONTENT_ENCODING = "content-encoding";

async function dispatch(request: ExpressRequest, response: ExpressResponse, url: URL, handler: TessarRequestHandler): Promise<void> {
  const connection = new AbortController();
  response.once("close", () => { if (!response.writableFinished) connection.abort(); });
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
    else if (value !== undefined) headers.set(name, value);
  }
  let body: BodyInit | null = null;
  if (!BODYLESS_METHODS.has(request.method)) {
    if (request.body !== undefined) {
      // The application has already consumed the native stream.
      headers.delete(CONTENT_LENGTH);
      headers.delete(CONTENT_ENCODING);
      body = Buffer.isBuffer(request.body) ? new Uint8Array(request.body) : JSON.stringify(request.body);
    } else body = Readable.toWeb(request, { strategy: {
      highWaterMark: request.readableHighWaterMark, size: (chunk: Uint8Array) => chunk.byteLength,
    } }) as unknown as ReadableStream<Uint8Array>;
  }
  const result = await handler(new Request(url, {
    method: request.method, headers, body, signal: connection.signal, duplex: "half",
  } as RequestInit));
  if (connection.signal.aborted) { await result.body?.cancel(); return; }
  response.statusCode = result.status;
  for (const [name, value] of result.headers) response.setHeader(name, value);
  if (result.body) await pipeline(Readable.fromWeb(result.body as unknown as NodeReadableStream), response).catch(error => {
    if (!connection.signal.aborted) throw error;
  });
  else response.end();
}

export class TessarServer extends TessarServerAdapter<Express> {
  protected registerHandler(handler: TessarRequestHandler): void {
    this.app.use((request, response, next) => {
      const url = new URL(request.url, `${request.protocol}://${request.get("host") ?? "localhost"}`);
      if (!this.accepts(url.pathname)) return next();
      void dispatch(request, response, url, handler).catch(next);
    });
  }
}
