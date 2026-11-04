import type { Plugin, PluginContext } from "@tessar/core";
import { createLibsqlBackend, type LibsqlStorageOptions } from "./backend.js";
export class LibsqlStoragePlugin implements Plugin {
  readonly id = "storage.libsql";
  constructor(private readonly options: LibsqlStorageOptions) { }
  async setup(tessar: PluginContext): Promise<void> {
    const backend = await createLibsqlBackend(this.options);
    try {
      tessar.storage.register(backend);
    } catch (error) {
      await backend.close().catch(() => { });
      throw error;
    }
  }
}
