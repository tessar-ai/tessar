import { fields, invalid } from "../runtime/validation.js";
import type { MiddlewareHandler, MiddlewareRegistration, RouteRegistration } from "../types.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
const ROUTE_FIELDS = ["method", "handler"];

export function registerRoute(path: string, options: Omit<RouteRegistration, "path">): RouteRegistration {
  fields(options, ROUTE_FIELDS);
  if (typeof path !== "string" || !path.startsWith("/") ||
    !HTTP_METHODS.includes(options.method) ||
    typeof options.handler !== "function") invalid("Invalid route declaration");
  return Object.freeze({ path, method: options.method, handler: options.handler });
}
export function registerMiddleware(path: string, handler: MiddlewareHandler): MiddlewareRegistration {
  if (typeof path !== "string" || (path !== "*" && !path.startsWith("/")) || typeof handler !== "function")
    invalid("Invalid middleware declaration");
  return Object.freeze({ path, handler });
}
