import type { Hono } from "hono";
import { controllerDescriptor } from "../descriptors.js";
import { required, ROUTE_PARAM } from "../protocol.js";
import type { RuntimeRegistry } from "../../runtime/runtime-registry.js";

const CONTROLLERS_PATH = "/api/controllers";
export const CONTROLLER_PATH = CONTROLLERS_PATH + "/:controllerId";

export function registerControllers(app: Hono, runtimes: () => RuntimeRegistry) {
  app.get(CONTROLLERS_PATH, c => c.json([...runtimes().controllers.values()].map(controllerDescriptor)));
  app.get(CONTROLLER_PATH, c => c.json(controllerDescriptor(required(runtimes().controllers.get(c.req.param(ROUTE_PARAM.CONTROLLER_ID)!)))));
}
