import { json, type EndpointRouter } from "../endpoint.js";
import { EventEnvelope, stateChanged } from "@tessar/core";
import type { SessionRegistry } from "../../runtime/session-registry.js";
import type { ThreadStateHub } from "../../runtime/thread-state-hub.js";
import { SESSION_PATH } from "./sessions.js";
import { safeState, ROUTE_PARAM } from "../protocol.js";

export function registerState(app: EndpointRouter, sessions: () => SessionRegistry, hub: ThreadStateHub) {
  app.get(SESSION_PATH + "/state", async c => json(safeState(await hub.getSnapshot(c.param(ROUTE_PARAM.CONTROLLER_ID)!,
    await sessions().get(c.param(ROUTE_PARAM.CONTROLLER_ID)!, c.param(ROUTE_PARAM.SESSION_ID)!, c.scope)))));
  app.get(SESSION_PATH + "/state/stream", async c => {
    const controllerId = c.param(ROUTE_PARAM.CONTROLLER_ID)!;
    const session = await sessions().get(controllerId, c.param(ROUTE_PARAM.SESSION_ID)!, c.scope);
    await hub.getSnapshot(controllerId, session);
    return { subscribe: (push, end) => {
      const off = hub.subscribe(controllerId, session, push, end);
      try {
        const state = hub.snapshot(controllerId, session);
        push(new EventEnvelope(stateChanged, { state }, {
          controllerId, agentId: session.agent.id, sessionId: session.id, scope: session.scope(), threadId: session.thread.getId() ?? undefined,
        }));
      } catch (error) { console.error(error); end(); }
      return () => { off(); void sessions().prune().catch(error => console.error(error)); };
    } };
  });
}
