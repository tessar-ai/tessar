import type { Agent, Controller } from "@tessar/core";
import type { Handler, MiddlewareHandler as HonoMiddlewareHandler } from "hono";
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
