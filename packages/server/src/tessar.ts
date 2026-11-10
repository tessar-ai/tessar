import type { Agent, Controller } from "@tessar/core";
import { fields, invalid } from "./runtime/validation.js";
import { TessarServerError, SERVER_ERROR_CODE } from "./errors.js";
import { createRuntime, runtimeFor } from "./runtime/context.js";
import type { TessarOptions } from "./types.js";
import { snapshotAuth } from "./http/access.js";

export class Tessar<User = unknown> {
  readonly server: Readonly<NonNullable<TessarOptions<User>["server"]>>;
  constructor(options: TessarOptions<User>) {
    fields(options, ["agents", "controllers", "server"]);
    for (const list of [options.agents, options.controllers])
      if (list !== undefined && !Array.isArray(list)) invalid("Expected registration array");
    const config = options.server ?? {};
    fields(config, ["hostname", "port", "routes", "middlewares", "prefix", "openapiPath", "auth"]);
    const auth = snapshotAuth(config.auth);
    if (config.hostname !== undefined && (typeof config.hostname !== "string" || !config.hostname.trim()) ||
      config.port !== undefined && (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)) invalid("Invalid listening address");
    for (const list of [config.routes, config.middlewares])
      if (list !== undefined && !Array.isArray(list)) invalid("Expected registration array");
    this.server = Object.freeze({
      ...config, auth,
      routes: config.routes && Object.freeze([...config.routes]), middlewares: config.middlewares && Object.freeze([...config.middlewares]),
    });
    createRuntime(this, options);
  }
  getAgent(id: string): Agent {
    const runtime = runtimeFor(this);
    const agent = runtime.registry.agents.get(id);
    if (!agent) throw new TessarServerError(SERVER_ERROR_CODE.AGENT_NOT_FOUND, "Agent not found: " + id);
    return agent;
  }
  getController(id: string): Controller {
    const controller = runtimeFor(this).registry.controllers.get(id);
    if (!controller) throw new TessarServerError(SERVER_ERROR_CODE.CONTROLLER_NOT_FOUND, "Controller not found: " + id);
    return controller;
  }
  shutdown(): Promise<void> { return runtimeFor(this).shutdown(); }
}
