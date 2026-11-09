import { EventEnvelope, stateChanged } from "@tessar/core";
import type { Hono } from "hono";
import type { SessionRegistry } from "../../runtime/session-registry.js";
import type { ThreadStateHub } from "../../runtime/thread-state-hub.js";
import type { SseTransport } from "../sse.js";
import { SESSION_PATH } from "./sessions.js";
import { safeState, ROUTE_PARAM } from "../protocol.js";

export function registerState(app: Hono, sessions: () => SessionRegistry, hub: ThreadStateHub, transport: SseTransport) {
  app.get(SESSION_PATH + "/state", async c => c.json(safeState(await hub.getSnapshot(c.req.param(ROUTE_PARAM.CONTROLLER_ID)!,
    await sessions().get(c.req.param(ROUTE_PARAM.CONTROLLER_ID)!, c.req.param(ROUTE_PARAM.SESSION_ID)!)))));
  app.get(SESSION_PATH + "/state/stream", async c => {
    const controllerId = c.req.param(ROUTE_PARAM.CONTROLLER_ID)!;
    const session = await sessions().get(controllerId, c.req.param(ROUTE_PARAM.SESSION_ID)!);
    await hub.getSnapshot(controllerId, session);
    return transport.response(c, (push, end) => {
      let version = 0;
      let closed = false;
      const off = hub.subscribe(controllerId, session, event => { version++; push(event); }, end);
      const initialVersion = version;
      void hub.getSnapshot(controllerId, session).then(state => {
        if (!closed && version === initialVersion) push(new EventEnvelope(stateChanged, { state }, {
          controllerId, agentId: session.agent.id, sessionId: session.id, scope: session.scope(), threadId: session.thread.getId() ?? undefined,
        }));
      }).catch(error => { console.error(error); end(); });
      return () => { closed = true; off(); };
    });
  });
}
