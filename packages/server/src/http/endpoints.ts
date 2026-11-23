import { errorInfo } from "@tessar/core";
import type { RuntimeContext } from "../runtime/context.js";
import { HTTP_ERROR_CODE, ROUTE_PARAM } from "./protocol.js";
import { registerAgents } from "./routes/agents.js";
import { registerControllers } from "./routes/controllers.js";
import { registerSessions } from "./routes/sessions.js";
import { registerThreads } from "./routes/threads.js";
import { registerRecords } from "./routes/records.js";
import { registerState } from "./routes/state.js";
import { EndpointRouter, type Endpoint, type EndpointRequest, type EndpointResult } from "./endpoint.js";

export function endpoints(runtime: RuntimeContext): readonly Endpoint[] {
  const router = new EndpointRouter();
  registerAgents(router, () => runtime.registry, runtime.hub);
  registerControllers(router, () => runtime.registry);
  registerSessions(router, () => runtime.registry, () => runtime.sessions);
  registerThreads(router, () => runtime.sessions);
  registerRecords(router, () => runtime.registry);
  registerState(router, () => runtime.sessions, runtime.hub);
  return router.routes;
}

export async function handleEndpoint(runtime: RuntimeContext, endpoint: Endpoint, request: EndpointRequest): Promise<EndpointResult> {
  try { return await endpoint.handle(request); }
  catch (error) {
    const sessionId = request.param(ROUTE_PARAM.SESSION_ID);
    if (sessionId !== undefined && errorInfo(error).code === HTTP_ERROR_CODE.COMMIT_CONFLICT) {
      const controllerId = request.param(ROUTE_PARAM.CONTROLLER_ID)!;
      const session = await runtime.sessions.get(controllerId, sessionId, request.scope);
      runtime.sessions.invalidate(controllerId, session);
    }
    throw error;
  }
}
