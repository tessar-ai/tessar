import type { Hono, Context } from "hono";
import { errorInfo } from "@tessar/core";
import { sessionDescriptor } from "../descriptors.js";
import { body, query, required, bad, ROUTE_PARAM, HTTP_ERROR_MESSAGE, HTTP_STATUS, SCOPED_PAGE_QUERY_FIELDS, HTTP_ERROR_CODE, wireModel } from "../protocol.js";
import type { RuntimeRegistry } from "../../runtime/runtime-registry.js";
import type { SessionRegistry } from "../../runtime/session-registry.js";

import { CONTROLLER_PATH } from "./controllers.js";
import { authScope, scoped } from "../access.js";
const SESSIONS_PATH = CONTROLLER_PATH + "/sessions";
export const SESSION_PATH = SESSIONS_PATH + "/:sessionId";
export function registerSessions(app: Hono, runtimes: () => RuntimeRegistry, sessions: () => SessionRegistry) {
  const controller = (c: Context) => required(runtimes().controllers.get(c.req.param(ROUTE_PARAM.CONTROLLER_ID)!));
  app.post(SESSIONS_PATH, async c => {
    const options = await body(c, ["id", "scope", "model", "metadata", "threadId"]);
    options.scope = scoped(c, options.scope);
    wireModel(options.model);
    const id = controller(c).id;
    return c.json(sessionDescriptor(id, await sessions().create(id, options)), HTTP_STATUS.CREATED);
  });
  app.get(SESSIONS_PATH, async c => {
    const options = query(c, SCOPED_PAGE_QUERY_FIELDS);
    options.scope = scoped(c, options.scope);
    return c.json(await controller(c).listSessions(options));
  });
  app.use(SESSION_PATH + "/*", async (c, next) => {
    const id = c.req.param(ROUTE_PARAM.CONTROLLER_ID)!;
    await next();
    if (c.error && errorInfo(c.error).code === HTTP_ERROR_CODE.COMMIT_CONFLICT) {
      const session = await sessions().get(id, c.req.param(ROUTE_PARAM.SESSION_ID)!, authScope(c));
      sessions().invalidate(id, session);
    }
  });
  const get = (c: Context) => sessions().get(c.req.param(ROUTE_PARAM.CONTROLLER_ID)!, c.req.param(ROUTE_PARAM.SESSION_ID)!, authScope(c));
  app.get(SESSION_PATH, async c => c.json(sessionDescriptor(c.req.param(ROUTE_PARAM.CONTROLLER_ID)!, await get(c))));
  app.post(SESSION_PATH + "/close", async c => { await sessions().close(c.req.param(ROUTE_PARAM.CONTROLLER_ID)!, c.req.param(ROUTE_PARAM.SESSION_ID)!, authScope(c)); return c.body(null, HTTP_STATUS.NO_CONTENT); });
  app.post(SESSION_PATH + "/follow-up", async c => {
    const value = await body(c, ["input"]);
    if (value.input === undefined) bad(HTTP_ERROR_MESSAGE.INPUT_REQUIRED);
    return c.json(await (await get(c)).followUp(value.input), HTTP_STATUS.ACCEPTED);
  });
  for (const operation of ["resume", "recover"] as const) app.post(SESSION_PATH + "/" + operation, async c => {
    const value = await body(c, operation === "resume" ? ["interruptId", "value", "model"] : ["streamId", "model"]);
    wireModel(value.model);
    if (operation === "resume" ? typeof value.interruptId !== "string" || !("value" in value) : typeof value.streamId !== "string")
      bad(HTTP_ERROR_MESSAGE.CONTINUATION_REQUIRED);
    const session = await get(c);
    return c.json(await (operation === "resume" ? session.resume(value as Parameters<typeof session.resume>[0]) :
      session.recover(value as Parameters<typeof session.recover>[0])), HTTP_STATUS.ACCEPTED);
  });
  app.post(SESSION_PATH + "/abort", async c => {
    const { reason } = await body(c, ["reason"]);
    if (reason !== undefined && typeof reason !== "string") bad(HTTP_ERROR_MESSAGE.REASON_MUST_BE_STRING);
    await (await get(c)).abort(reason); return c.body(null, HTTP_STATUS.NO_CONTENT);
  });
  app.get(SESSION_PATH + "/queue", async c => {
    const session = await get(c);
    return c.json({ count: session.followUp.count(), isEmpty: session.followUp.isEmpty() });
  });
  app.get(SESSION_PATH + "/model", async c => c.json((await get(c)).model.info()));
  app.get(SESSION_PATH + "/models", async c => c.json((await get(c)).model.list()));
  app.post(SESSION_PATH + "/model/switch", async c => {
    const value = await body(c, ["modelId", "options"]);
    if (typeof value.modelId !== "string") bad("modelId is required");
    await (await get(c)).model.switch(value.modelId, value.options); return c.body(null, HTTP_STATUS.NO_CONTENT);
  });
  app.post(SESSION_PATH + "/model/effort", async c => {
    const { level } = await body(c, ["level"]);
    if (typeof level !== "string") bad("level is required");
    await (await get(c)).model.setEffort(level); return c.body(null, HTTP_STATUS.NO_CONTENT);
  });
}
