import fastify, { errorCodes, type FastifyError, type FastifyHttpOptions, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { maxHeaderSize, type Server as HttpServer } from "node:http";
import { authenticate } from "../http/access.js";
import { endpoints, handleEndpoint } from "../http/endpoints.js";
import { openapiDocument } from "../http/openapi.js";
import { DEFAULT_OPENAPI_PATH, validateServerPaths } from "../http/paths.js";
import { describeHttpError, HTTP_ERROR_CODE, HTTP_STATUS, MAX_REQUEST_BODY_BYTES, payloadTooLarge } from "../http/protocol.js";
import { SSE_HEADERS, SseTransport } from "../http/sse.js";
import { TessarServerError } from "../errors.js";
import { runtimeFor } from "../runtime/context.js";
import { invalid } from "../runtime/validation.js";
import type { Tessar } from "../tessar.js";

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 4117;
const HEAD_METHOD = "HEAD";
const BODYLESS_METHODS = new Set(["GET", HEAD_METHOD]);
const INVALID_BODY_CODES = new Set([
  "FST_ERR_CTP_INVALID_JSON_BODY", "FST_ERR_CTP_EMPTY_JSON_BODY", "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
]);

function webRequest(request: FastifyRequest, reply: FastifyReply, prefix: string, body?: Buffer): Request {
  const url = new URL(request.url, `${request.protocol}://${request.host}`);
  url.pathname = url.pathname.slice(prefix.length);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!name.startsWith(":") && value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const connection = new AbortController();
  const disconnect = () => { if (!reply.raw.writableFinished) connection.abort(); };
  if (reply.raw.destroyed) disconnect();
  else reply.raw.once("close", disconnect);
  return new Request(url, { method: request.method, headers, signal: AbortSignal.any([connection.signal, request.signal]),
    body: body?.length && !BODYLESS_METHODS.has(request.method) ? new Uint8Array(body) : undefined });
}

function registerApi(app: FastifyInstance, tessar: Tessar<any>, prefix: string, openapiPath: string, transport: SseTransport): void {
  const runtime = runtimeFor(tessar);
  const routes = endpoints(runtime);
  const { auth, fastifyOptions } = tessar.server;
  const bodyLimit = fastifyOptions?.bodyLimit ?? MAX_REQUEST_BODY_BYTES;
  const bodies = new WeakMap<FastifyRequest, { raw?: Buffer; error?: Error }>();
  const parseJson = app.getDefaultJsonParser(fastifyOptions?.onProtoPoisoning ?? "error", fastifyOptions?.onConstructorPoisoning ?? "error");
  app.removeAllContentTypeParsers();
  app.addContentTypeParser<Buffer>("*", { parseAs: "buffer" }, (request, body, done) => {
    parseJson(request, body.toString(), (error, value) => {
      // Native hooks see parsed JSON. Tessar reports parse errors after authentication.
      if (auth || error) bodies.set(request, { raw: auth ? body : undefined, error: error ?? undefined });
      done(null, value);
    });
  });
  app.setErrorHandler((error, _request, reply) => {
    const native = error as Partial<FastifyError> | undefined;
    if (error instanceof errorCodes.FST_ERR_CTP_BODY_TOO_LARGE) error = payloadTooLarge(bodyLimit);
    else if (INVALID_BODY_CODES.has(native?.code ?? "")) error = new TessarServerError(HTTP_ERROR_CODE.INVALID_REQUEST, "Expected JSON object");
    const { status, payload } = describeHttpError(error);
    const nativeStatus = native?.statusCode;
    reply.code(status === HTTP_STATUS.INTERNAL_SERVER_ERROR && typeof nativeStatus === "number" && Number.isInteger(nativeStatus)
      && nativeStatus >= HTTP_STATUS.BAD_REQUEST && nativeStatus < HTTP_STATUS.INTERNAL_SERVER_ERROR ? nativeStatus : status).send(payload);
  });
  for (const endpoint of routes) app.route<{ Params: Record<string, string>; Querystring: Record<string, string | string[]> }>({
    method: endpoint.method, url: endpoint.path, bodyLimit,
    async handler(request, reply) {
      const response = await runtime.sessions.request(async () => {
        const body = bodies.get(request);
        bodies.delete(request);
        const scope = auth ? await authenticate(webRequest(request, reply, prefix, body?.raw), auth) : undefined;
        const result = await handleEndpoint(runtime, endpoint, {
          scope, param: name => request.params[name], readJson: () => {
            if (body?.error) throw body.error;
            return request.body;
          },
          queries: () => Object.fromEntries(Object.entries(request.query).map(([key, value]) => [key, Array.isArray(value) ? value : [value]])),
        });
        if ("subscribe" in result) return { stream: request.method === HEAD_METHOD ? null : transport.open(result.subscribe, () => { reply.raw.destroy(); }) };
        return result;
      });
      if ("stream" in response) return reply.headers(SSE_HEADERS).send(response.stream ?? undefined);
      return reply.code(response.status).send(response.payload);
    },
  });
  const document = openapiDocument(routes, prefix);
  app.get(openapiPath, async () => document);
}

export async function startSelfHost(tessar: Tessar<any>): Promise<{ url: string; shutdown(): Promise<void> }> {
  const {
    hostname = DEFAULT_HOSTNAME, port = DEFAULT_PORT, prefix = "", openapiPath = DEFAULT_OPENAPI_PATH,
    routes, middlewares, configure, fastifyOptions,
  } = tessar.server;
  const transport = new SseTransport();
  let app: FastifyInstance | undefined;
  let disposal: Promise<void> | undefined;
  const shutdown = () => disposal ??= (async () => {
    transport.close();
    const results = await Promise.allSettled([app?.close(), tessar.shutdown()]);
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Server cleanup failed");
  })();
  try {
    if (routes?.length || middlewares?.length) invalid("Move self-hosted server.routes and server.middlewares to server.configure to use Fastify");
    validateServerPaths(prefix, openapiPath);
    await runtimeFor(tessar).ready();
    // The host uses the same instance methods across Fastify's HTTP, HTTPS and HTTP/2 overloads.
    const options = fastifyOptions as FastifyHttpOptions<HttpServer> | undefined;
    app = fastify({ ...options, routerOptions: { maxParamLength: maxHeaderSize, ...options?.routerOptions } });
    app.addHook("preClose", async () => { transport.close(); });
    app.register(async scope => {
      await configure?.(scope);
      scope.register(async api => { registerApi(api, tessar, prefix, openapiPath, transport); });
    }, { prefix });
    const url = await app.listen({ host: hostname, port });
    return { url, shutdown };
  } catch (error) {
    await shutdown().catch(cleanup => console.error(cleanup));
    throw error;
  }
}
