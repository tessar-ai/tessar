import type { Plugin, PluginContext } from "@tessar/core";

export class {{className}}Plugin implements Plugin {
  readonly id = "{{name}}";

  constructor(private readonly kind: string, private readonly value: unknown) {}

  setup(tessar: PluginContext): void {
    // Use tessar.defer() for resources this plugin creates.
    tessar.registry.register(this.kind, this.id, this.value);
  }
}
