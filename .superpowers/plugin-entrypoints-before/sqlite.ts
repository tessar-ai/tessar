export * from "./backend.js";
import type { Plugin, PluginContext } from "@tessar/core";
import { createSqliteBackend, type SqliteStorageOptions } from "./backend.js";
export class SqliteStoragePlugin implements Plugin {
  readonly id = "storage.sqlite";
  constructor(private readonly options: SqliteStorageOptions) {}
  async setup(tessar: PluginContext): Promise<void> {
    const backend = await createSqliteBackend(this.options);
    try {
      tessar.storage.register(backend);
    } catch (error) {
      await backend.close().catch(() => {});
      throw error;
    }
  }
}
