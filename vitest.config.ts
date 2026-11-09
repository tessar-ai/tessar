import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
const path = (name: string) => fileURLToPath(new URL(name, import.meta.url));
export default defineConfig({
  resolve: { alias: [
    { find: "@tessar/client", replacement: path("./packages/client/src/index.ts") },
    { find: "@tessar/server/hono", replacement: path("./packages/server/src/framework/hono.ts") },
    { find: "@tessar/server/express", replacement: path("./packages/server/src/framework/express.ts") },
    { find: "@tessar/server", replacement: path("./packages/server/src/index.ts") },
    { find: "@tessar/rag", replacement: path("./packages/rag/src/index.ts") },
    { find: "@tessar/plugins/logger", replacement: path("./packages/plugins/src/build-in/logger.ts") },
    { find: "@tessar/opentelemetry", replacement: path("./packages/opentelemetry/src/index.ts") },
    { find: "@tessar/plugins", replacement: path("./packages/plugins/src/index.ts") },
    { find: "@tessar/core/testing/storage-conformance", replacement: path("./packages/core/src/testing/storage-conformance.ts") },
    { find: "@tessar/core/testing", replacement: path("./packages/core/src/testing/index.ts") },
    { find: "@tessar/core/tool", replacement: path("./packages/core/src/tools/index.ts") },
    { find: "@tessar/core", replacement: path("./packages/core/src/index.ts") },
    { find: "@tessar/libsql/vector", replacement: path("./packages/libsql/src/vector.ts") },
    { find: "@tessar/libsql", replacement: path("./packages/libsql/src/index.ts") },
    { find: "@tessar/postgresql/vector", replacement: path("./packages/postgresql/src/vector.ts") },
    { find: "@tessar/postgresql", replacement: path("./packages/postgresql/src/index.ts") },
    { find: "@tessar/mongodb/vector", replacement: path("./packages/mongodb/src/vector.ts") },
    { find: "@tessar/mongodb", replacement: path("./packages/mongodb/src/index.ts") },
    { find: "@tessar/openai", replacement: path("./packages/openai/src/index.ts") },
  ] },
  test: { include: ["packages/*/test/**/*.test.ts", "tests/integration/**/*.test.ts"], testTimeout: 15000 }
});

