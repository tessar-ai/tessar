import type { Agent, Controller } from "@tessar/core";
import type { Handler, MiddlewareHandler as HonoMiddlewareHandler } from "hono";
import type { FastifyHttp2Options, FastifyHttp2SecureOptions, FastifyHttpOptions, FastifyHttpsOptions, FastifyInstance } from "fastify";
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Http2Server, Http2SecureServer } from "node:http2";
import type { Tessar } from "./tessar.js";
import type { AuthOptions } from "./auth.js";

export type RouteHandler = Handler;
export type MiddlewareHandler = HonoMiddlewareHandler;
export interface RouteRegistration {
  readonly path: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
  readonly handler: RouteHandler;
}
export interface MiddlewareRegistration {
  readonly path: string;
  readonly handler: MiddlewareHandler;
}
export interface ServerOptions<User = unknown> {
  auth?: AuthOptions<User>;
  hostname?: string;
  port?: number;
  routes?: readonly RouteRegistration[];
  middlewares?: readonly MiddlewareRegistration[];
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
