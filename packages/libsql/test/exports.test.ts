import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import * as storage from "../src/index.js";

it("keeps the root entry independent of vector/RAG exports", () => {
  expect(Object.keys(storage).sort()).toEqual(["LibsqlStoragePlugin", "createLibsqlBackend"]);
});

it("offers vector as a separate entry and RAG only as an optional peer", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(manifest.exports["./vector"]).toEqual({ types: "./dist/vector.d.ts", import: "./dist/vector.js" });
  expect(manifest.dependencies["@tessar/rag"]).toBeUndefined();
  expect(manifest.peerDependencies?.["@tessar/rag"]).toBe("workspace:^");
  expect(manifest.peerDependenciesMeta?.["@tessar/rag"]).toEqual({ optional: true });
  expect(manifest.devDependencies?.["@tessar/rag"]).toBe("workspace:*");
  expect(manifest.dependencies.libsql).toBeUndefined();
  expect(manifest.peerDependencies.libsql).toBe("0.5.29");
  expect(manifest.peerDependenciesMeta.libsql).toEqual({ optional: true });
});
