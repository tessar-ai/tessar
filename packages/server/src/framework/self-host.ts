import fastify, { type FastifyHttpOptions, type FastifyInstance } from "fastify";
import { maxHeaderSize, type Server as HttpServer } from "node:http";
import { FASTIFY_PRE_CLOSE_HOOK, registerFastifyApi } from "../http/fastify.js";
import { DEFAULT_OPENAPI_PATH, validateServerPaths } from "../http/paths.js";
import { MAX_REQUEST_BODY_BYTES } from "../http/protocol.js";
import { SseTransport } from "../http/sse.js";
import { runtimeFor } from "../runtime/context.js";
import type { Tessar } from "../tessar.js";

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 4117;

export async function startSelfHost(tessar: Tessar<any>): Promise<{ url: string; shutdown(): Promise<void> }> {
  const {
    hostname = DEFAULT_HOSTNAME, port = DEFAULT_PORT, prefix = "", openapiPath = DEFAULT_OPENAPI_PATH,
    configure, fastifyOptions,
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
    validateServerPaths(prefix, openapiPath);
    await runtimeFor(tessar).ready();
    // The host uses the same instance methods across Fastify's HTTP, HTTPS and HTTP/2 overloads.
    const options = fastifyOptions as FastifyHttpOptions<HttpServer> | undefined;
    app = fastify({ ...options, routerOptions: { maxParamLength: maxHeaderSize, ...options?.routerOptions } });
    app.addHook(FASTIFY_PRE_CLOSE_HOOK, async () => { transport.close(); });
    const bodyLimit = fastifyOptions?.bodyLimit ?? MAX_REQUEST_BODY_BYTES;
    app.register(async scope => {
      await configure?.(scope);
      scope.register(async api => { registerFastifyApi(api, tessar, openapiPath, transport, bodyLimit); });
    }, { prefix });
    const url = await app.listen({ host: hostname, port });
    return { url, shutdown };
  } catch (error) {
    await shutdown().catch(cleanup => console.error(cleanup));
    throw error;
  }
}
