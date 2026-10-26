import { PluginHost } from "../plugins/host.js";
import type { ValueRegistration } from "../plugins/registry.js";
import type { ErrorInfo } from "../errors.js";
import type { EventContext } from "../events/definition.js";
import { createMemoryBackend } from "../state/memory-backend.js";
import { guardStorage } from "../state/storage-errors.js";
import { StateQueries } from "../state/queries.js";
import type { StorageBackend } from "../state/storage-ports.js";
import type { Tool } from "../tools/tool.js";

// Structural execution dependencies shared by standalone calls and Controller.
export interface ExecutionRuntime {
  readonly id?: string;
  readonly backend: StorageBackend;
  readonly queries: StateQueries;
  readonly hooks: PluginHost;
  report(error: ErrorInfo, context?: EventContext): void;
}

export function toolRegistrations(
  agentId: string,
  tools: readonly Tool[],
): ValueRegistration[] {
  return tools.map((tool) => ({
    kind: "tool",
    id: tool.name,
    value: tool,
    version: 1,
    pluginId: agentId,
    pluginVersion: 1,
    configurationId: tool.configurationId,
  }));
}

export function standaloneRuntime(
  agentId: string,
  tools: readonly Tool[],
): ExecutionRuntime {
  const backend = guardStorage(createMemoryBackend());
  const report = () => {};
  return {
    backend,
    queries: new StateQueries(backend),
    report,
    hooks: new PluginHost({
      values: toolRegistrations(agentId, tools),
      diagnostics: report,
    }),
  };
}
