import type { FastifyInstance } from "fastify";
import { FASTIFY_PRE_CLOSE_HOOK, registerFastifyApi, type FastifyApp } from "../http/fastify.js";
import { HTTP_STATUS } from "../http/protocol.js";
import { SseTransport } from "../http/sse.js";
import { ServerAdapter } from "./adapter.js";

const REQUEST_HOOK = "onRequest";

export class TessarServer<App extends FastifyApp = FastifyInstance> extends ServerAdapter<App> {
  private readonly transport = new SseTransport();

  protected mount(): void {
    this.app.register(async scope => {
      scope.addHook(REQUEST_HOOK, async (_request, reply) => {
        if (this.closed) return reply.code(HTTP_STATUS.SERVICE_UNAVAILABLE).send({ error: this.disposed().toJSON() });
      });
      registerFastifyApi(scope, this.tessar, this.openapiPath, this.transport);
    }, { prefix: this.prefix });
    this.app.addHook(FASTIFY_PRE_CLOSE_HOOK, async () => { await this.shutdown(); });
  }

  protected closeTransport(): void { this.transport.close(); }
}
