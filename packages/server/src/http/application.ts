import { URLPattern } from "node:url";
import { TessarServerError } from "../errors.js";
import type { RuntimeContext } from "../runtime/context.js";
import type { ServerOptions } from "../types.js";
import { authenticate } from "./access.js";
import { endpoints, handleEndpoint } from "./endpoints.js";
import { openapiDocument } from "./openapi.js";
import { DEFAULT_OPENAPI_PATH } from "./paths.js";
import { bad, describeHttpError, limitBody, HTTP_STATUS, HTTP_ERROR_CODE, HTTP_ERROR_MESSAGE } from "./protocol.js";
import { SSE_HEADERS, SseTransport } from "./sse.js";

const METHOD = { GET: "GET", HEAD: "HEAD" } as const;

export class ServerApplication {
  private readonly routes;
  private readonly openapiPath;
  private readonly document;
  private readonly transport = new SseTransport();

  constructor(private readonly runtime: RuntimeContext, private readonly config: ServerOptions<any> = {}) {
    const routes = endpoints(runtime);
    this.routes = routes.map(endpoint => ({ endpoint, pattern: new URLPattern({ pathname: endpoint.path }) }));
    this.openapiPath = config.openapiPath ?? DEFAULT_OPENAPI_PATH;
    this.document = openapiDocument(routes, config.prefix ?? "");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const head = request.method === METHOD.HEAD;
    const method = head ? METHOD.GET : request.method;
    try {
      if (method === METHOD.GET && url.pathname === this.openapiPath)
        return head ? new Response(null) : Response.json(this.document);
      for (const { endpoint, pattern } of this.routes) {
        if (endpoint.method !== method) continue;
        const match = pattern.exec({ pathname: url.pathname });
        if (!match) continue;
        const input = limitBody(request);
        return await this.runtime.sessions.request(async () => {
          const scope = this.config.auth ? await authenticate(input, this.config.auth) : undefined;
          const result = await handleEndpoint(this.runtime, endpoint, {
            scope,
            param: name => {
              const value = match.pathname.groups[name];
              if (value === undefined) return;
              try { return decodeURIComponent(value); } catch { return bad("Invalid route parameter"); }
            },
            queries: () => {
              const values: Record<string, string[]> = Object.create(null);
              for (const [key, value] of url.searchParams) (values[key] ??= []).push(value);
              return values;
            },
            readJson: () => input.json(),
          });
          if ("subscribe" in result)
            return new Response(head ? null : this.transport.open(result.subscribe), { headers: SSE_HEADERS });
          const { status, payload } = result;
          return head || status === HTTP_STATUS.NO_CONTENT ? new Response(null, { status }) : Response.json(payload, { status });
        });
      }
      throw new TessarServerError(HTTP_ERROR_CODE.NOT_FOUND, HTTP_ERROR_MESSAGE.NOT_FOUND);
    } catch (error) {
      const { status, payload } = describeHttpError(error);
      return head ? new Response(null, { status }) : Response.json(payload, { status });
    }
  }

  shutdown(): void { this.transport.close(); }
}
