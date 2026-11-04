import type { Plugin, PluginContext, Tool } from "@tessar/core";

export class {{className}}Plugin implements Plugin {
  readonly id = "{{name}}";

  constructor(private readonly tool: Tool) {}

  setup(tessar: PluginContext): void {
    // Use tessar.defer() for resources this plugin creates.
    tessar.tools.register(this.tool);
  }
}
