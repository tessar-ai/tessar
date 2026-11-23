import { json, type EndpointRouter } from "../endpoint.js";
import { controllerDescriptor } from "../descriptors.js";
import { required, ROUTE_PARAM } from "../protocol.js";
import type { RuntimeRegistry } from "../../runtime/runtime-registry.js";

const CONTROLLERS_PATH = "/api/controllers";
export const CONTROLLER_PATH = CONTROLLERS_PATH + "/:controllerId";

export function registerControllers(app: EndpointRouter, runtimes: () => RuntimeRegistry) {
  app.get(CONTROLLERS_PATH, c => json([...runtimes().controllers.values()].map(controllerDescriptor)));
  app.get(CONTROLLER_PATH, c => json(controllerDescriptor(required(runtimes().controllers.get(c.param(ROUTE_PARAM.CONTROLLER_ID)!)))));
}
