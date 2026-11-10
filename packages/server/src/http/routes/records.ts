import type { Context, Hono } from "hono";
import { body, query, required, ROUTE_PARAM, HTTP_STATUS, SCOPED_PAGE_QUERY_FIELDS } from "../protocol.js";
import type { RuntimeRegistry } from "../../runtime/runtime-registry.js";
import { CONTROLLER_PATH } from "./controllers.js";
import { scoped } from "../access.js";

export function registerRecords(app: Hono, runtimes: () => RuntimeRegistry) {
  const store = (c: Context) => required(runtimes().records.get(c.req.param(ROUTE_PARAM.CONTROLLER_ID)!));
  const path = CONTROLLER_PATH + "/records/:namespace";
  app.post(path, async c => {
    const value = await body(c, ["id", "scope", "data"]);
    value.scope = scoped(c, value.scope);
    return c.json(await store(c).append({ ...value, namespace: c.req.param(ROUTE_PARAM.NAMESPACE)!, data: value.data }), HTTP_STATUS.CREATED);
  });
  app.get(path, async c => {
    const options = query(c, SCOPED_PAGE_QUERY_FIELDS);
    return c.json(await store(c).list({ ...options, scope: scoped(c, options.scope), namespace: c.req.param(ROUTE_PARAM.NAMESPACE)! }));
  });
  app.get(path + "/:recordId", async c => {
    const options = query(c, ["scope"]);
    return c.json(required(await store(c).get(c.req.param(ROUTE_PARAM.NAMESPACE)!, c.req.param(ROUTE_PARAM.RECORD_ID)!, { scope: scoped(c, options.scope) })));
  });
}
