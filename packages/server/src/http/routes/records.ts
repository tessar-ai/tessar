import type { Context, Hono } from "hono";
import { body, query, required, ROUTE_PARAM, HTTP_STATUS, SCOPED_PAGE_QUERY_FIELDS } from "../protocol.js";
import type { RuntimeRegistry } from "../../runtime/runtime-registry.js";
import { CONTROLLER_PATH } from "./controllers.js";

export function registerRecords(app: Hono, runtimes: () => RuntimeRegistry) {
  const store = (c: Context) => required(runtimes().records.get(c.req.param(ROUTE_PARAM.CONTROLLER_ID)!));
  const path = CONTROLLER_PATH + "/records/:namespace";
  app.post(path, async c => {
    const value = await body(c, ["id", "scope", "data"]);
    return c.json(await store(c).append({ ...value, namespace: c.req.param(ROUTE_PARAM.NAMESPACE)!, data: value.data }), HTTP_STATUS.CREATED);
  });
  app.get(path, async c => c.json(await store(c).list({ ...query(c, SCOPED_PAGE_QUERY_FIELDS), namespace: c.req.param(ROUTE_PARAM.NAMESPACE)! })));
  app.get(path + "/:recordId", async c => c.json(required(await store(c).get(c.req.param(ROUTE_PARAM.NAMESPACE)!, c.req.param(ROUTE_PARAM.RECORD_ID)!, query(c, ["scope"])))));
}
