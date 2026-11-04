import type { Agent, Controller } from "@tessar/core";
import type { Handler, MiddlewareHandler as HonoMiddlewareHandler } from "hono";

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
export interface ServerOptions {
  hostname?: string;
  port?: number;
  routes?: readonly RouteRegistration[];
  middlewares?: readonly MiddlewareRegistration[];
}
export interface TessarOptions {
  agents?: readonly Agent[];
  controllers?: readonly Controller[];
  server?: ServerOptions;
}
