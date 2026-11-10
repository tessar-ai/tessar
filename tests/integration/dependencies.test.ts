import { expect, test } from "vitest";
import { readFileSync } from "node:fs";

const DATABASE_PACKAGES = ["libsql", "postgresql", "mongodb"];
const manifest = (name: string) => {
  const directory = DATABASE_PACKAGES.includes(name) ? "plugins/database" : "packages";
  return JSON.parse(readFileSync(new URL(`../../${directory}/${name}/package.json`, import.meta.url), "utf8"));
};
const EXTENSIONS = ["openai", "libsql", "postgresql", "mongodb", "opentelemetry", "rag", "typesafe", "server"];

test.each(EXTENSIONS)("%s shares a compatible application core instead of pinning a private core", name => {
  const pkg = manifest(name);
  expect(pkg.dependencies?.["@tessar/core"]).toBeUndefined();
  expect(pkg.peerDependencies?.["@tessar/core"]).toBe("workspace:^");
  expect(pkg.peerDependenciesMeta?.["@tessar/core"]?.optional).not.toBe(true);
  expect(pkg.devDependencies?.["@tessar/core"]).toBe("workspace:*");
});

test("CLI keeps a compatible runtime core and client stays dependency-free", () => {
  expect(manifest("cli").dependencies["@tessar/core"]).toBe("workspace:^");
  const client = manifest("client");
  expect(Object.keys(client.dependencies ?? {})).toEqual([]);
  expect(Object.keys(client.peerDependencies ?? {})).toEqual([]);
});

test("test runner and feature-specific peers do not install by default", () => {
  const core = manifest("core");
  expect(core.peerDependencies.vitest).toBe("^5.0.4");
  expect(core.peerDependenciesMeta.vitest.optional).toBe(true);
  expect(core.dependencies?.vitest).toBeUndefined();
  expect(manifest("plugins").peerDependenciesMeta["@tessar/core"].optional).toBe(true);
  for (const [name, driver] of [["libsql", "libsql"], ["postgresql", "pg"], ["mongodb", "mongodb"]]) {
    const pkg = manifest(name!);
    expect(pkg.peerDependenciesMeta[driver!].optional).toBe(true);
    expect(pkg.peerDependenciesMeta["@tessar/rag"].optional).toBe(true);
    expect(pkg.dependencies?.[driver!]).toBeUndefined();
    expect(pkg.dependencies?.["@tessar/rag"]).toBeUndefined();
  }
});
