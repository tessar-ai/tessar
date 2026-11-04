import type { Plugin, PluginContext, StorageBackend } from "@tessar/core";

export class {{className}}Plugin implements Plugin {
  readonly id = "{{name}}";

  constructor(private readonly backend: StorageBackend) {}

  setup(tessar: PluginContext): void {
    // Use tessar.defer() for resources this plugin creates.
    tessar.storage.register(this.backend);
  }
}
