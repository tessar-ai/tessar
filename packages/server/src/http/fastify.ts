import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { TessarServerError } from "../errors.js";
import { runtimeFor } from "../runtime/context.js";
import type { Tessar } from "../tessar.js";
import { authenticate } from "./access.js";
import { endpoints, handleEndpoint } from "./endpoints.js";
import { openapiDocument } from "./openapi.js";
import { describeHttpError, HTTP_ERROR_CODE, HTTP_STATUS, MAX_REQUEST_BODY_BYTES, payloadTooLarge } from "./protocol.js";
import { SSE_HEADERS, type SseTransport } from "./sse.js";

export type FastifyApp = FastifyInstance<any, any, any, any, any>;
export const FASTIFY_PRE_CLOSE_HOOK = "preClose";

const HEAD_METHOD = "HEAD";
const BODYLESS_METHODS = new Set(["GET", HEAD_METHOD]);
const BODY_TOO_LARGE_CODE = "FST_ERR_CTP_BODY_TOO_LARGE";
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
  const requestSignal = request.signal;
  const signal = requestSignal ? AbortSignal.any([connection.signal, requestSignal]) : connection.signal;
  return new Request(url, { method: request.method, headers, signal,
    body: body?.length && !BODYLESS_METHODS.has(request.method) ? new Uint8Array(body) : undefined });
}

export function registerFastifyApi(
  app: FastifyApp, tessar: Tessar<any>, openapiPath: string, transport: SseTransport,
  bodyLimit = app.initialConfig.bodyLimit ?? MAX_REQUEST_BODY_BYTES,
): void {
  const prefix = app.prefix;
  const runtime = runtimeFor(tessar);
  const routes = endpoints(runtime);
  const { auth } = tessar.server;
  const bodies = new WeakMap<FastifyRequest, { raw?: Buffer; error?: Error }>();
  const parseJson = app.getDefaultJsonParser(app.initialConfig.onProtoPoisoning ?? "error", app.initialConfig.onConstructorPoisoning ?? "error");
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
    if (native?.code === BODY_TOO_LARGE_CODE) error = payloadTooLarge(bodyLimit);
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
