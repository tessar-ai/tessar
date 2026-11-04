import type { Plugin, PluginContext, ModelProviderRegistration } from "@tessar/core";

export class {{className}}Plugin implements Plugin {
  readonly id = "{{name}}";

  constructor(private readonly provider: ModelProviderRegistration) {}

  setup(tessar: PluginContext): void {
    // Use tessar.defer() for resources this plugin creates.
    tessar.models.register(this.provider);
  }
}
