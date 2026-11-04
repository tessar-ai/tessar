import { describe, expect, it } from "vitest";
import { componentFile, projectFiles, type ScaffoldMetadata } from "../src/templates.js";
import * as events from "../../core/src/events/type.js";
import type { Backend, ProjectOptions } from "../src/project-options.js";

const metadata: ScaffoldMetadata = {
  coreVersion: "0.1.5", openaiVersion: "0.1.4", zodVersion: "^4.6.7",
  typescriptVersion: "^6.0.0", nodeTypesVersion: "^24.0.0",
  backendVersions: { libsql: "0.1.3", postgresql: "0.1.2", mongodb: "0.1.1" },
  driverVersions: { libsql: "0.5.29", pg: "^8.16.3", mongodb: "^6.21.0", pgTypes: "^8.15.5" },
  hooks: { "ready": "notification", "context.prepare": "transformation", "turn.before": "decision" },
};

describe("scaffold templates", () => {
  const configurations: ProjectOptions[] = [
    { controller: false, session: false, backend: "memory" },
    ...(["memory", "libsql", "postgresql", "mongodb"] as Backend[]).flatMap(backend =>
      [false, true].map(session => ({ controller: true, session, backend }))),
  ];

  it.each(configurations)("composes only selected capabilities: %j", options => {
    const files = projectFiles("my-app", metadata, options);
    const manifest = JSON.parse(files["package.json"]!);
    expect(Object.hasOwn(files, "src/controllers/main.ts")).toBe(options.controller);
    expect(Object.hasOwn(files, "src/sessions/chat.ts")).toBe(options.session);
    expect(Object.hasOwn(files, "src/storage.ts")).toBe(options.backend !== "memory");
    const expectedDependencies: Record<string, string> = {
      "@tessar/core": metadata.coreVersion, "@tessar/openai": metadata.openaiVersion, zod: metadata.zodVersion,
    };
    if (options.backend !== "memory") {
      expectedDependencies[`@tessar/${options.backend}`] = metadata.backendVersions[options.backend];
      const driver = options.backend === "postgresql" ? "pg" : options.backend;
      expectedDependencies[driver] = metadata.driverVersions[driver];
      expect(files["src/main.ts"]).toContain("await storage.close()");
    }
    expect(manifest.dependencies).toEqual(expectedDependencies);
    expect(manifest.devDependencies["@types/pg"]).toBe(options.backend === "postgresql" ? metadata.driverVersions.pgTypes : undefined);
    expect(files[".env.example"]!.includes("LIBSQL_PATH")).toBe(options.backend === "libsql");
    expect(files[".env.example"]!.includes("POSTGRES_URL")).toBe(options.backend === "postgresql");
    expect(files[".env.example"]!.includes("MONGODB_URL")).toBe(options.backend === "mongodb");
    expect(files[".gitignore"]!.includes("*.db-*")).toBe(options.backend === "libsql");
    if (options.controller) {
      expect(files["src/controllers/main.ts"]).toBe(componentFile("controller", "main", {}, metadata).content);
      expect(files["src/main.ts"]).toContain("await controller.initialize()");
      expect(files["src/main.ts"]).toContain("await controller.dispose()");
    }
    if (options.session) {
      expect(files["src/main.ts"]).toContain("await session.thread.create");
      expect(files["src/main.ts"]).toContain("session.followUp(");
      for (const terminal of ["end", "error", "suspended"]) expect(files["src/main.ts"]).toContain(`stream.${terminal}`);
      expect(files["src/main.ts"]).toContain("unsubscribe()");
    }
    expect(Object.values(files).join("\n")).not.toMatch(/\{\{\w+\}\}/);
  });

  it.each([
    { controller: false, session: true, backend: "memory" },
    { controller: false, session: false, backend: "libsql" },
    { controller: true, session: false, backend: "unknown" },
  ])("rejects impossible configuration: %j", options => {
    expect(() => projectFiles("my-app", metadata, options as ProjectOptions)).toThrow(/Controller/);
  });

  it("covers every built-in event exported by core", () => {
    function names(value: unknown): string[] {
      if (typeof value === "string") return [value];
      if (value && typeof value === "object") return Object.values(value).flatMap(names);
      return [];
    }
    const { hookKinds, ...definitions } = events;
    const expected = [...new Set(Object.values(definitions).flatMap(names))].sort();
    expect(Object.keys(hookKinds).sort()).toEqual(expected);
    for (const event of expected) {
      const file = componentFile("plugin", "event-check", { type: "hook", event }, { ...metadata, hooks: hookKinds });
      expect(file.content).toContain(`tessar.hook("${event}"`);
      expect(file.content.includes("return event.payload")).toBe(hookKinds[event] === "transformation");
    }
  });
  it("creates a complete ESM project with supplied dependency versions and environment configuration", () => {
    const files = projectFiles("my-app", metadata);
    expect(Object.keys(files).sort()).toEqual([".env.example", ".gitignore", "README.md", "package.json", "src/agents/assistant.ts", "src/main.ts", "tsconfig.json"]);
    const manifest = JSON.parse(files["package.json"]!);
    expect(manifest.dependencies).toEqual({ "@tessar/core": "0.1.5", "@tessar/openai": "0.1.4", zod: "^4.6.7" });
    expect(manifest.scripts.start).toContain("dist/main.js");
    expect(files["src/main.ts"]).toContain('"./agents/assistant.js"');
    expect(files["src/main.ts"]).toContain("if (!apiKey || !model)");
    expect(files[".gitignore"]).toContain("!.env.example");
    expect(Object.values(files).join("\n")).not.toMatch(/\{\{\w+\}\}/);
  });

  it("rejects incomplete template data instead of writing unresolved placeholders", () => {
    expect(() => projectFiles("my-app", { ...metadata, coreVersion: undefined } as unknown as ScaffoldMetadata)).toThrow(/coreVersion/);
  });

  it.each(["agent", "tool", "controller"])("creates a named %s module without import-time execution", (kind) => {
    const file = componentFile(kind, "my-example", {}, metadata);
    expect(file.path).toBe(`src/${kind}s/my-example.ts`);
    expect(file.content).toContain(kind === "tool" ? "myExampleTool" : `createMyExample${kind === "agent" ? "Agent" : "Controller"}`);
    expect(file.content).not.toContain("await ");
  });

  it("creates a Session factory using the caller's Controller and SessionOptions", () => {
    const file = componentFile("session", "my-chat", {}, metadata);
    expect(file.path).toBe("src/sessions/my-chat.ts");
    expect(file.content).toContain("createMyChatSession");
    expect(file.content).toContain("controller.createSession(options)");
    expect(file.content).not.toContain("new Session");
    expect(file.content).not.toContain("initialize()");
  });

  it.each([
    ["basic", "TODO: Register"], ["tool", "tessar.tools.register(this.tool)"],
    ["provider", "tessar.models.register(this.provider)"], ["storage", "tessar.storage.register(this.backend)"],
    ["capability", "tessar.registry.register(this.kind, this.id, this.value)"],
  ])("creates the %s plugin with caller-owned registration values", (type, registration) => {
    const file = componentFile("plugin", "my-plugin", { type }, metadata);
    expect(file.path).toBe("src/plugins/my-plugin.ts");
    expect(file.content).toContain("class MyPluginPlugin implements Plugin");
    expect(file.content).toContain(registration);
    expect(file.content).toContain("tessar.defer()");
  });

  it("returns transformation payloads and leaves other hook kinds as no-op placeholders", () => {
    for (const [event, kind] of Object.entries(metadata.hooks)) {
      const { content } = componentFile("plugin", "observer", { type: "hook", event }, metadata);
      expect(content).toContain(`tessar.hook("${event}"`);
      expect(content.includes("return event.payload")).toBe(kind === "transformation");
    }
  });

  it.each([
    ["unknown", {}], ["agent", { type: "basic" }], ["tool", { event: "ready" }],
    ["plugin", { type: "unknown" }], ["plugin", { event: "ready" }],
    ["plugin", { type: "hook" }], ["plugin", { type: "hook", event: "unknown" }],
    ["plugin", { type: "hook", event: "toString" }],
  ])("rejects unsupported kind/options: %s %j", (kind, options) => {
    expect(() => componentFile(kind, "example", options, metadata)).toThrow(Error);
  });
});
