import { MongoClient } from "mongodb";
import { MongoDBStoragePlugin } from "@tessar/mongodb";

export function createStorage() {
  const url = process.env.MONGODB_URL;
  const name = process.env.MONGODB_DATABASE;
  if (!url || !name) throw new Error("Set MONGODB_URL and MONGODB_DATABASE in .env.");
  const client = new MongoClient(url);
  return { plugin: new MongoDBStoragePlugin({ database: client.db(name) }), close: () => client.close() };
}
