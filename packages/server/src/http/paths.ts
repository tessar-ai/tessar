import { invalid } from "../runtime/validation.js";

export const DEFAULT_OPENAPI_PATH = "/openapi.json";

export function validateServerPaths(prefix: string, openapiPath: string): void {
  for (const [name, path] of [["prefix", prefix], ["openapiPath", openapiPath]] as const) {
    if (name === "prefix" && path === "") continue;
    if (typeof path !== "string" || !/^\/(?:[A-Za-z0-9_.~-]+\/?)+$/.test(path) || path.endsWith("/") || path.split("/").some(part => part === "." || part === ".."))
      invalid(name + " must be an absolute path without a trailing slash, query or fragment");
  }
  if (openapiPath === "/api" || openapiPath.startsWith("/api/")) invalid("OpenAPI path must be outside /api");
}
