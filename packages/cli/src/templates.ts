import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultProjectOptions, type ProjectOptions } from "./project-options.js";

export interface ScaffoldMetadata {
  coreVersion: string;
  openaiVersion: string;
  zodVersion: string;
  typescriptVersion: string;
  nodeTypesVersion: string;
  backendVersions: { libsql: string; postgresql: string; mongodb: string };
  driverVersions: { libsql: string; pg: string; mongodb: string; pgTypes: string };
  hooks: Readonly<Record<string, string>>;
}

const templates = new URL("../templates/", import.meta.url);

function render(path: string, values: Readonly<Record<string, string>>): string {
  return readFileSync(new URL(path, templates), "utf8").replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key) || typeof values[key] !== "string") {
      throw new Error(`Missing template value: ${key} (${path}).`);
    }
    return values[key];
  });
}

export function projectFiles(name: string, metadata: ScaffoldMetadata, options: ProjectOptions = defaultProjectOptions): Record<string, string> {
  if (typeof options.controller !== "boolean" || typeof options.session !== "boolean" ||
    !["memory", "libsql", "postgresql", "mongodb"].includes(options.backend) ||
    (!options.controller && (options.session || options.backend !== "memory"))) {
    throw new Error("Session and storage require a Controller and a supported backend.");
  }
  const files: Record<string, string> = {};
  const root = fileURLToPath(new URL("project/", templates));
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const relativePath = relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/");
    const destination = relativePath.replace(/\.tpl$/, "").replace(/^_gitignore$/, ".gitignore").replace(/^_env\.example$/, ".env.example");
    files[destination] = render(`project/${relativePath}`, {
      name, coreVersion: metadata.coreVersion, openaiVersion: metadata.openaiVersion,
      zodVersion: metadata.zodVersion, typescriptVersion: metadata.typescriptVersion,
      nodeTypesVersion: metadata.nodeTypesVersion,
      configuration: options.controller
        ? `This starter initializes a Controller with ${options.backend} storage${options.session ? ", creates a Session and thread, and waits for the streamed response" : " and generates one response"}. It disposes the Controller when finished.`
        : "This starter generates one response with an Agent.",
    });
  }
  files["src/agents/assistant.ts"] = componentFile("agent", "assistant", {}, metadata).content;
  if (options.controller) {
    const persistent = options.backend !== "memory";
    files["src/controllers/main.ts"] = componentFile("controller", "main", {}, metadata).content;
    if (options.session) files["src/sessions/chat.ts"] = componentFile("session", "chat", {}, metadata).content;
    files["src/main.ts"] = render("composition/main.ts.tpl", {
      setup: render(`composition/${persistent ? "persistent" : "memory"}-setup.ts.tpl`, {}),
      execution: render(`composition/${options.session ? "session" : "generate"}.ts.tpl`, {}),
      cleanup: render(`composition/${persistent ? "persistent" : "memory"}-cleanup.ts.tpl`, {}),
    });
    if (persistent) {
      files["src/storage.ts"] = render(`composition/${options.backend}/storage.ts.tpl`, {});
      files[".env.example"] += render(`composition/${options.backend}/env.tpl`, {});
      files["README.md"] += render(`composition/${options.backend}/readme.tpl`, {});
      const manifest = JSON.parse(files["package.json"]!);
      const backendVersion = metadata.backendVersions[options.backend as keyof ScaffoldMetadata["backendVersions"]];
      const driver = options.backend === "postgresql" ? "pg" : options.backend;
      const driverVersion = metadata.driverVersions[driver as "libsql" | "pg" | "mongodb"];
      if (!backendVersion || !driverVersion || (options.backend === "postgresql" && !metadata.driverVersions.pgTypes)) {
        throw new Error(`Missing dependency versions for ${options.backend}.`);
      }
      manifest.dependencies[`@tessar/${options.backend}`] = backendVersion;
      manifest.dependencies[driver] = driverVersion;
      if (options.backend === "postgresql") manifest.devDependencies["@types/pg"] = metadata.driverVersions.pgTypes;
      files["package.json"] = JSON.stringify(manifest, null, 2) + "\n";
      if (options.backend === "libsql") files[".gitignore"] += render("composition/libsql/gitignore.tpl", {});
    }
  }
  return files;
}

export function componentFile(kind: string, name: string, options: { type?: string; event?: string }, metadata: ScaffoldMetadata): { path: string; content: string } {
  if (!["agent", "tool", "controller", "session", "plugin"].includes(kind)) throw new Error(`Unsupported component kind: ${kind}.`);
  if (kind !== "plugin" && (options.type !== undefined || options.event !== undefined)) {
    throw new Error("--type and --event are only supported for plugins.");
  }
  let template = `${kind}/${kind}.ts.tpl`;
  if (kind === "plugin") {
    const type = options.type ?? "basic";
    if (!["basic", "tool", "hook", "provider", "storage", "capability"].includes(type)) throw new Error(`Unsupported plugin type: ${type}.`);
    if (type !== "hook" && options.event !== undefined) throw new Error("--event is only supported for hook plugins.");
    if (type === "hook") {
      if (!options.event) throw new Error("Hook plugins require --event <event>.");
      if (!Object.hasOwn(metadata.hooks, options.event)) throw new Error(`Unsupported hook event: ${options.event}.`);
    }
    template = `plugin/${type === "hook" && metadata.hooks[options.event!] === "transformation" ? "hook-transformation" : type}.ts.tpl`;
  }
  return {
    path: `src/${kind}s/${name}.ts`,
    content: render(template, {
      name,
      className: name.split("-").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(""),
      variableName: name.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase()),
      event: JSON.stringify(options.event ?? ""),
    }),
  };
}
