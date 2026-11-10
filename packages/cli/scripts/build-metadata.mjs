import { readFile, writeFile } from "node:fs/promises";
import { hookKinds } from "../../core/dist/events/type.js";

const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const core = await read("../../core/package.json");
const openai = await read("../../openai/package.json");
const libsql = await read("../../../plugins/database/libsql/package.json");
const postgresql = await read("../../../plugins/database/postgresql/package.json");
const mongodb = await read("../../../plugins/database/mongodb/package.json");
const root = await read("../../../package.json");
await writeFile(new URL("../dist/scaffold-metadata.json", import.meta.url), JSON.stringify({
  coreVersion: core.version,
  openaiVersion: openai.version,
  zodVersion: root.devDependencies.zod,
  typescriptVersion: root.devDependencies.typescript,
  nodeTypesVersion: root.devDependencies["@types/node"],
  backendVersions: { libsql: libsql.version, postgresql: postgresql.version, mongodb: mongodb.version },
  driverVersions: { libsql: root.devDependencies.libsql, pg: root.devDependencies.pg, mongodb: root.devDependencies.mongodb, pgTypes: root.devDependencies["@types/pg"] },
  hooks: hookKinds,
}, null, 2) + "\n");
