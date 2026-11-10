import type { Plugin, PluginContext } from "@tessar/core";
import { createMongoDBBackend, type MongoDBStorageOptions } from "./backend.js";

export class MongoDBStoragePlugin implements Plugin {
  readonly id = "storage.mongodb";
  constructor(private readonly options: MongoDBStorageOptions) {}
  async setup(tessar: PluginContext): Promise<void> {
    const backend = await createMongoDBBackend(this.options);
    try {
      tessar.storage.register(backend);
    } catch (error) {
      await backend.close().catch(() => {});
      throw error;
    }
  }
}
