import type { Scope } from "@tessar/core";
import { HTTP_STATUS } from "./protocol.js";
import type { StateSubscription } from "./sse.js";

const METHOD = { GET: "GET", POST: "POST", DELETE: "DELETE" } as const;

export interface EndpointRequest {
  readonly scope?: Scope;
  param(name: string): string | undefined;
  queries(): Record<string, string[]>;
  readJson(): unknown | Promise<unknown>;
}

export type EndpointResult =
  | { status: number; payload: unknown }
  | { subscribe: StateSubscription };

export interface Endpoint {
  readonly method: typeof METHOD[keyof typeof METHOD];
  readonly path: string;
  readonly handle: (request: EndpointRequest) => EndpointResult | Promise<EndpointResult>;
}

export class EndpointRouter {
  readonly routes: Endpoint[] = [];
  get(path: string, handle: Endpoint["handle"]): void { this.routes.push({ method: METHOD.GET, path, handle }); }
  post(path: string, handle: Endpoint["handle"]): void { this.routes.push({ method: METHOD.POST, path, handle }); }
  delete(path: string, handle: Endpoint["handle"]): void { this.routes.push({ method: METHOD.DELETE, path, handle }); }
}

export function json(payload: unknown, status: number = HTTP_STATUS.OK): EndpointResult { return { status, payload }; }
export function noContent(): EndpointResult { return { status: HTTP_STATUS.NO_CONTENT, payload: undefined }; }
