export {
  createPostgresqlBackend,
  type PostgresqlStorageOptions,
} from "./backend.js";
import type { Plugin, PluginContext } from "@tessar/core";
import {
  createPostgresqlBackend,
  type PostgresqlStorageOptions,
} from "./backend.js";

export class PostgresqlStoragePlugin implements Plugin {
  readonly id = "storage.postgresql";
  constructor(private readonly options: PostgresqlStorageOptions) {}
  async setup(tessar: PluginContext): Promise<void> {
    const backend = await createPostgresqlBackend(this.options);
    try {
      tessar.storage.register(backend);
    } catch (error) {
      await backend.close().catch(() => {});
      throw error;
    }
  }
}
