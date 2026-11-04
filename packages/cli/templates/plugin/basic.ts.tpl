import type { Plugin, PluginContext } from "@tessar/core";

export class {{className}}Plugin implements Plugin {
  readonly id = "{{name}}";

  setup(tessar: PluginContext): void {
    // Use tessar.defer() for resources this plugin creates.
    // TODO: Register plugin behavior.
  }
}
