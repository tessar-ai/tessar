import type { Agent, Controller } from "@tessar/core";
import type { FastifyHttp2Options, FastifyHttp2SecureOptions, FastifyHttpOptions, FastifyHttpsOptions, FastifyInstance } from "fastify";
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Http2Server, Http2SecureServer } from "node:http2";
import type { Tessar } from "./tessar.js";
import type { AuthOptions } from "./auth.js";

export interface ServerOptions<User = unknown> {
  auth?: AuthOptions<User>;
  hostname?: string;
  port?: number;
  prefix?: string;
  openapiPath?: string;
  fastifyOptions?: FastifyHttpOptions<HttpServer> | FastifyHttpsOptions<HttpsServer> |
    FastifyHttp2Options<Http2Server> | FastifyHttp2SecureOptions<Http2SecureServer>;
  configure?: (app: FastifyInstance) => void | Promise<void>;
}
export type TessarRequestHandler = (request: Request) => Promise<Response>;
export interface TessarServerOptions<App> {
  app: App;
  tessar: Tessar<any>;
  prefix?: string;
  openapiPath?: string;
}
export interface TessarOptions<User = unknown> {
  agents?: readonly Agent[];
  controllers?: readonly Controller[];
  server?: ServerOptions<User>;
}
