import type { Hono, Context } from "hono";
import { errorInfo } from "@tessar/core";
import { sessionDescriptor } from "../descriptors.js";
import { body, query, required, bad, ROUTE_PARAM, HTTP_ERROR_MESSAGE, HTTP_STATUS, SCOPED_PAGE_QUERY_FIELDS, HTTP_ERROR_CODE } from "../protocol.js";
import type { RuntimeRegistry } from "../../runtime/runtime-registry.js";
import type { SessionRegistry } from "../../runtime/session-registry.js";

export const C = "/api/controllers/:controllerId";
const SESSIONS_PATH = C + "/sessions";
export const S = SESSIONS_PATH + "/:sessionId";
export function registerSessions(app: Hono, runtimes: () => RuntimeRegistry, sessions: () => SessionRegistry) {
  const controller = (c: Context) => required(runtimes().controllers.get(c.req.param(ROUTE_PARAM.CONTROLLER_ID)!));
  app.post(SESSIONS_PATH, async c => {
    const options = await body(c, ["id", "scope", "model", "metadata", "threadId"]);
    wireModel(options.model);
    const id = controller(c).id;
    return c.json(sessionDescriptor(id, await sessions().create(id, options)), HTTP_STATUS.CREATED);
  });
  app.get(SESSIONS_PATH, async c => c.json(await controller(c).listSessions(query(c, SCOPED_PAGE_QUERY_FIELDS))));
  app.use(S + "/*", async (c, next) => {
    const id = c.req.param(ROUTE_PARAM.CONTROLLER_ID)!;
    const session = await sessions().get(id, c.req.param(ROUTE_PARAM.SESSION_ID)!);
    await next();
    if (c.error && errorInfo(c.error).code === HTTP_ERROR_CODE.COMMIT_CONFLICT) sessions().invalidate(id, session);
  });
  const get = (c: Context) => sessions().get(c.req.param(ROUTE_PARAM.CONTROLLER_ID)!, c.req.param(ROUTE_PARAM.SESSION_ID)!);
  app.get(S, async c => c.json(sessionDescriptor(c.req.param(ROUTE_PARAM.CONTROLLER_ID)!, await get(c))));
  app.post(S + "/close", async c => { await sessions().close(c.req.param(ROUTE_PARAM.CONTROLLER_ID)!, c.req.param(ROUTE_PARAM.SESSION_ID)!); return c.body(null, HTTP_STATUS.NO_CONTENT); });
  app.post(S + "/follow-up", async c => {
    const value = await body(c, ["input"]);
    if (value.input === undefined) bad(HTTP_ERROR_MESSAGE.INPUT_REQUIRED);
    return c.json(await (await get(c)).followUp(value.input), HTTP_STATUS.ACCEPTED);
  });
  for (const operation of ["resume", "recover"] as const) app.post(S + "/" + operation, async c => {
    const value = await body(c, operation === "resume" ? ["interruptId", "value", "model"] : ["streamId", "model"]);
    wireModel(value.model);
    if (operation === "resume" ? typeof value.interruptId !== "string" || !("value" in value) : typeof value.streamId !== "string")
      bad(HTTP_ERROR_MESSAGE.CONTINUATION_REQUIRED);
    const session = await get(c);
    return c.json(await (operation === "resume" ? session.resume(value as Parameters<typeof session.resume>[0]) :
      session.recover(value as Parameters<typeof session.recover>[0])), HTTP_STATUS.ACCEPTED);
  });
  app.post(S + "/abort", async c => {
    const { reason } = await body(c, ["reason"]);
    if (reason !== undefined && typeof reason !== "string") bad(HTTP_ERROR_MESSAGE.REASON_MUST_BE_STRING);
    await (await get(c)).abort(reason); return c.body(null, HTTP_STATUS.NO_CONTENT);
  });
  app.get(S + "/queue", async c => {
    const session = await get(c);
    return c.json({ count: session.followUp.count(), isEmpty: session.followUp.isEmpty() });
  });
  app.get(S + "/model", async c => c.json((await get(c)).model.info()));
  app.get(S + "/models", async c => c.json((await get(c)).model.list()));
  app.post(S + "/model/switch", async c => {
    const value = await body(c, ["modelId", "options"]);
    if (typeof value.modelId !== "string") bad("modelId is required");
    await (await get(c)).model.switch(value.modelId, value.options); return c.body(null, HTTP_STATUS.NO_CONTENT);
  });
  app.post(S + "/model/effort", async c => {
    const { level } = await body(c, ["level"]);
    if (typeof level !== "string") bad("level is required");
    await (await get(c)).model.setEffort(level); return c.body(null, HTTP_STATUS.NO_CONTENT);
  });
}

export function wireModel(model: unknown, allowId = false) {
  if (model === undefined || (allowId && typeof model === "string" && model.trim())) return;
  if (!model || typeof model !== "object" || Array.isArray(model) ||
    Object.keys(model).some(key => !["providerId", "modelId", "connectionId"].includes(key)) ||
    !("providerId" in model) || !("modelId" in model) ||
    Object.values(model).some(value => typeof value !== "string")) bad("Expected a model ID or JSON ModelRef");
}
