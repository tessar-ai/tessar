import { Agent, Controller, type RecordStore } from "@tessar/core";
import { invalid } from "../registration.js";
import type { TessarOptions } from "../types.js";

export class RuntimeRegistry {
  readonly controllers = new Map<string, Controller>();
  readonly records = new Map<string, RecordStore>();

  constructor(options: TessarOptions) {
    const controllers = [...(options.controllers ?? [])];
    const agents = [...(options.agents ?? [])];
    const controllerIds = new Set<string>();
    const agentIds = new Set<string>();
    for (const controller of controllers) {
      if (!(controller instanceof Controller) || controllerIds.has(controller.id) || agentIds.has(controller.agent.id))
        invalid("Duplicate or invalid Controller registration");
      controllerIds.add(controller.id);
      agentIds.add(controller.agent.id);
    }
    for (const agent of agents) {
      if (!(agent instanceof Agent) || agentIds.has(agent.id) || controllerIds.has(agent.id))
        invalid("Duplicate or invalid Agent registration");
      agentIds.add(agent.id);
      controllerIds.add(agent.id);
    }
    if (!agentIds.size) invalid("Register at least one Agent or Controller");
    try {
      for (const agent of agents) controllers.push(new Controller({ id: agent.id, agent }));
    } catch (error) {
      for (const controller of controllers.slice(options.controllers?.length ?? 0)) void controller.dispose();
      throw error;
    }
    for (const controller of controllers) this.controllers.set(controller.id, controller);
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.controllers.values()].map(value => value.dispose()));
    const errors = results.flatMap(value => value.status === "rejected" ? [value.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Runtime cleanup failed");
  }
}
