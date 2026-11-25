import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
const root = resolve(import.meta.dirname, ".."),
  errors = [],
  graph = new Map();
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.name === "node_modules" || entry.name === "dist"
      ? []
      : entry.isDirectory()
        ? files(resolve(directory, entry.name))
        : [resolve(directory, entry.name)],
  );
}
const core = files(resolve(root, "packages/core/src")).filter(
  (path) =>
    path.endsWith(".ts") &&
    !path.includes("/testing/") &&
    !path.includes("\\testing\\"),
);
const nodePlugins = resolve(root, "packages/core/src/plugins/node");
const isNodePlugin = (file) => dirname(file) === nodePlugins;
for (const file of core) {
  const text = readFileSync(file, "utf8"),
    imports = [
      ...text.matchAll(
        /\b(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']/g,
      ),
    ].map((match) => match[1]);
  for (const specifier of imports)
    if (
      (specifier.startsWith("node:") && !isNodePlugin(file)) ||
      specifier.startsWith("@tessar/") ||
      specifier === "openai" ||
      specifier === "vitest"
    )
      errors.push(
        relative(root, file) + ": forbidden core import " + specifier,
      );
  const dependencies = imports
    .filter((name) => name.startsWith("."))
    .map((name) => resolve(dirname(file), name.replace(/\.js$/, ".ts")))
    .filter((path) => existsSync(path) && path.endsWith(".ts"));
  if (!isNodePlugin(file) && dependencies.some(isNodePlugin))
    errors.push(relative(root, file) + ": forbidden Node plugin import");
  graph.set(file, dependencies);
  if (/\b(?:AgentEngine|RuntimePort|bindRuntime|apiVersion)\b/.test(text))
    errors.push(relative(root, file) + ": obsolete runtime abstraction");
}
const visiting = new Set(),
  visited = new Set();
function visit(file) {
  if (visiting.has(file)) {
    errors.push("Runtime import cycle at " + relative(root, file));
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file);
  for (const next of graph.get(file) ?? []) visit(next);
  visiting.delete(file);
  visited.add(file);
}
for (const file of core) visit(file);
for (const file of ["examples", "tests/fixtures/apps"]
  .flatMap((directory) => files(resolve(root, directory)))
  .filter((path) => path.endsWith(".ts"))) {
  if (
    /(?:@tessar\/[^"']+\/src\/|(?:\.\.\/)+(?:packages\/[^"']+|integrations\/auth\/[^"']+|plugins\/[^"']+)\/src\/)/.test(
      readFileSync(file, "utf8"),
    )
  )
    errors.push(relative(root, file) + ": private package import");
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log("Package boundaries verified");
