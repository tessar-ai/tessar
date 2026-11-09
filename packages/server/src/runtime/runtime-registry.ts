import { Agent, Controller, type RecordStore } from "@tessar/core";
import { invalid } from "./validation.js";
import type { TessarOptions } from "../types.js";

export class RuntimeRegistry {
  readonly agents = new Map<string, Agent>();
  readonly controllers = new Map<string, Controller>();
  readonly agentControllers = new Map<string, string>();
  readonly records = new Map<string, RecordStore>();
  private readonly independentAgents: readonly Agent[];

  constructor(options: TessarOptions) {
    const controllers = [...(options.controllers ?? [])];
    this.independentAgents = [...(options.agents ?? [])];
    for (const controller of controllers) {
      if (!(controller instanceof Controller) || this.controllers.has(controller.id) || this.agents.has(controller.agent.id))
        invalid("Duplicate or invalid Controller registration");
      this.controllers.set(controller.id, controller);
      this.agents.set(controller.agent.id, controller.agent);
      this.agentControllers.set(controller.agent.id, controller.id);
    }
    for (const agent of this.independentAgents) {
      if (!(agent instanceof Agent) || this.agents.has(agent.id))
        invalid("Duplicate or invalid Agent registration");
      this.agents.set(agent.id, agent);
    }
    if (!this.agents.size) invalid("Register at least one Agent or Controller");
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled([
      ...[...this.controllers.values()].map(controller => controller.dispose()),
      ...this.independentAgents.map(agent => agent.shutdown()),
    ]);
    const errors = results.flatMap(value => value.status === "rejected" ? [value.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Runtime cleanup failed");
  }
}
