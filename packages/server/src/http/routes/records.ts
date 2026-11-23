import { json, type EndpointRequest, type EndpointRouter } from "../endpoint.js";
import { body, query, required, ROUTE_PARAM, HTTP_STATUS, SCOPED_PAGE_QUERY_FIELDS } from "../protocol.js";
import type { RuntimeRegistry } from "../../runtime/runtime-registry.js";
import { CONTROLLER_PATH } from "./controllers.js";
import { scoped } from "../access.js";

export function registerRecords(app: EndpointRouter, runtimes: () => RuntimeRegistry) {
  const store = (c: EndpointRequest) => required(runtimes().records.get(c.param(ROUTE_PARAM.CONTROLLER_ID)!));
  const path = CONTROLLER_PATH + "/records/:namespace";
  app.post(path, async c => {
    const value = await body(c, ["id", "scope", "data"]);
    value.scope = scoped(c.scope, value.scope);
    return json(await store(c).append({ ...value, namespace: c.param(ROUTE_PARAM.NAMESPACE)!, data: value.data }), HTTP_STATUS.CREATED);
  });
  app.get(path, async c => {
    const options = query(c, SCOPED_PAGE_QUERY_FIELDS);
    return json(await store(c).list({ ...options, scope: scoped(c.scope, options.scope), namespace: c.param(ROUTE_PARAM.NAMESPACE)! }));
  });
  app.get(path + "/:recordId", async c => {
    const options = query(c, ["scope"]);
    return json(required(await store(c).get(c.param(ROUTE_PARAM.NAMESPACE)!, c.param(ROUTE_PARAM.RECORD_ID)!, { scope: scoped(c.scope, options.scope) })));
  });
}
