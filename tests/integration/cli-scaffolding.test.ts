import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { hookKinds } from "../../packages/core/src/events/type.js";

const execute = promisify(execFile);
const cli = resolve("packages/cli/dist/bin.js");

async function run(bin: string, args: string[], cwd: string, answers?: string) {
  const result = execute(process.execPath, [bin, ...args], { cwd, windowsHide: true, timeout: 30000 });
  result.child.stdin?.end(answers ?? (args[0] === "new" ? "n\ny\n" : undefined));
  return result;
}

async function linkSdk(project: string) {
  for (const [name, source] of [
    ["@tessar/core", "packages/core"],
    ["@tessar/openai", "packages/openai"],
    ["zod", "node_modules/zod"],
    ["@types/node", "node_modules/@types/node"],
  ] as const) {
    const target = join(project, "node_modules", name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(realpathSync(resolve(source)), target, process.platform === "win32" ? "junction" : "dir");
  }
}

it("compiles every generated template and hook against the public SDK and runs generated factories", async () => {
  const root = await mkdtemp(join(tmpdir(), "tessar scaffolding "));
  try {
    await run(cli, ["new", "sample-app"], root);
    const project = join(root, "sample-app");
    for (const file of ["package.json", "tsconfig.json", ".gitignore", ".env.example", "README.md", "src/main.ts", "src/agents/assistant.ts"])
      expect(existsSync(join(project, file)), file).toBe(true);
    const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    expect(manifest.type).toBe("module");
    expect(manifest.scripts.start).toBeTruthy();
    expect(manifest.scripts.typecheck).toBeTruthy();
    for (const name of ["core", "openai"]) {
      const sdk = JSON.parse(await readFile(resolve(`packages/${name}/package.json`), "utf8"));
      expect(manifest.dependencies[`@tessar/${name}`]).toContain(sdk.version);
    }
    await linkSdk(project);
    for (const kind of ["agent", "tool", "controller", "session"])
      await run(cli, ["generate", kind, "sample"], project);
    for (const type of ["basic", "tool", "provider", "storage", "capability"])
      await run(cli, ["g", "plugin", `${type}-example`, "--type", type], project);
    for (const [index, event] of Object.keys(hookKinds).entries())
      await run(cli, ["g", "plugin", `hook-${index}`, "--type", "hook", "--event", event], project);
    await run(cli, ["g", "plugin", "default-example"], project);
    await run(resolve("node_modules/typescript/bin/tsc"), ["--project", "tsconfig.json"], project);

    await writeFile(join(project, "smoke.mjs"), `
import assert from "node:assert/strict";
import { ScriptedProvider } from "@tessar/core/testing";
import { createSampleAgent } from "./dist/agents/sample.js";
import { createSampleController } from "./dist/controllers/sample.js";
import { createSampleSession } from "./dist/sessions/sample.js";
const agent = createSampleAgent(new ScriptedProvider([{ text: "generated answer" }]));
const controller = createSampleController({ agent });
try {
  await controller.initialize();
  const session = await createSampleSession(controller, {
    id: "chat", threadId: "conversation", scope: { userId: "demo" }, metadata: { project: "sample" },
  });
  assert.equal(session.id, "chat");
  assert.equal(session.thread.getId(), "conversation");
  assert.equal(session.scope().userId, "demo");
  assert.equal(session.metadata().project, "sample");
  const first = await createSampleSession(controller);
  const second = await createSampleSession(controller);
  assert.notEqual(first.id, second.id);
  await session.close();
  assert.equal(session.isDisposed(), true);
  const result = await agent.generate("hello");
  assert.equal(result.status, "completed");
  assert.equal(result.output[0]?.content[0]?.text, "generated answer");
} finally { await controller.dispose(); }
`);
    await run(join(project, "smoke.mjs"), [], project);
    await writeFile(join(project, "main-smoke.mjs"), `
import assert from "node:assert/strict";
process.env.OPENAI_API_KEY = "local-test-key";
process.env.OPENAI_MODEL = "local-test-model";
let calls = 0;
globalThis.fetch = async (_url, options) => {
  calls++;
  const request = JSON.parse(options.body);
  assert.equal(request.model, "local-test-model");
  assert.equal(request.stream, true);
  const chunk = { type: "response.completed", sequence_number: 1, response: {
    id: "local-response", status: "completed", output: [{
      type: "message", id: "local-message", role: "assistant",
      content: [{ type: "output_text", text: "starter answer", annotations: [] }],
    }],
  } };
  return new Response("event: response.completed\\ndata: " + JSON.stringify(chunk) + "\\n\\n", { headers: { "content-type": "text/event-stream" } });
};
await import("./dist/main.js");
assert.equal(calls, 1);
`);
    expect((await run(join(project, "main-smoke.mjs"), [], project)).stdout).toContain("starter answer");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60000);

it("packs and installs the standalone CLI and scaffolds from a different working directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "tessar installed scaffolding "));
  try {
    const host = join(root, "host"), work = join(root, "work"), cache = join(root, "cache");
    await mkdir(host);
    await mkdir(work);
    await writeFile(join(host, "package.json"), JSON.stringify({ private: true }));
    const packed = await command("pnpm", ["pack", "--config.ignore-scripts=true", "--json", "--pack-destination", root], resolve("packages/cli"), cache);
    const tarball = resolve(root, JSON.parse(packed.stdout).filename);
    const corePacked = await command("pnpm", ["pack", "--config.ignore-scripts=true", "--json", "--pack-destination", root], resolve("packages/core"), cache);
    const zodPacked = await command("pnpm", ["pack", "--config.ignore-scripts=true", "--config.manage-package-manager-versions=false", "--json", "--pack-destination", root], realpathSync(resolve("node_modules/zod")), cache);
    const archives = [resolve(root, JSON.parse(corePacked.stdout).filename), resolve(root, JSON.parse(zodPacked.stdout).filename), tarball];
    for (const dependency of ["hono", "@hono/node-server"]) {
      const packed = await command("pnpm", ["pack", "--config.ignore-scripts=true", "--config.manage-package-manager-versions=false", "--json", "--pack-destination", root], realpathSync(resolve("packages/cli/node_modules", dependency)), cache);
      archives.push(resolve(root, JSON.parse(packed.stdout).filename));
    }
    await command("npm", ["install", "--global", "--prefix", host, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=verbose", ...archives], work, cache);
    const installed = join(host, process.platform === "win32" ? "node_modules" : "lib/node_modules", "tessar");
    const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    expect(manifest.name).toBe("tessar");
    const coreManifest = JSON.parse(await readFile(resolve("packages/core/package.json"), "utf8"));
    expect(manifest.dependencies).toEqual({ "@tessar/core": "^" + coreManifest.version, hono: "4.13.16", "@hono/node-server": "2.1.6" });
    expect(typeof manifest.bin.tessar).toBe("string");
    const bin = join(installed, manifest.bin.tessar);
    expect(existsSync(bin)).toBe(true);
    expect(existsSync(join(installed, "templates/project/package.json.tpl"))).toBe(true);
    expect(existsSync(join(installed, "templates/project/_gitignore.tpl"))).toBe(true);
    expect(existsSync(join(installed, "templates/project/_env.example.tpl"))).toBe(true);
    expect(existsSync(join(installed, "templates/plugin/hook-transformation.ts.tpl"))).toBe(true);
    expect(existsSync(join(installed, "templates/session/session.ts.tpl"))).toBe(true);
    for (const backend of ["libsql", "postgresql", "mongodb"])
      expect(existsSync(join(installed, `templates/composition/${backend}/storage.ts.tpl`))).toBe(true);
    const launcher = process.platform === "win32" ? join(host, "tessar.cmd") : join(host, "bin/tessar");
    expect(existsSync(launcher)).toBe(true);
    const launched = process.platform === "win32"
      ? await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "& $env:TESSAR_TEST_BIN --version; exit $LASTEXITCODE"], {
        cwd: work, windowsHide: true, timeout: 10000, env: { ...process.env, TESSAR_TEST_BIN: launcher },
      })
      : await execute(launcher, ["--version"], { cwd: work, timeout: 10000 });
    expect(launched.stdout.trim()).toBe(manifest.version);
    const help = await run(bin, ["--help"], work);
    for (const text of ["new", "generate", "agent", "tool", "controller", "session", "basic", "hook", "provider", "storage", "capability"])
      expect(help.stdout).toContain(text);
    expect((await run(bin, ["--version"], work)).stdout.trim()).toBe(manifest.version);
    const local = join(root, "local");
    await mkdir(local);
    await writeFile(join(local, "package.json"), JSON.stringify({ private: true }));
    await command("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", ...archives], local, cache);
    expect((await command("npx", ["--offline", "tessar", "--version"], local, cache)).stdout.trim()).toBe(manifest.version);
    await run(bin, ["new", "installed-app"], work, "y\ny\n1\ny\n");
    const project = join(work, "installed-app");
    expect(existsSync(join(project, "src/controllers/main.ts"))).toBe(true);
    expect(existsSync(join(project, "src/sessions/chat.ts"))).toBe(true);
    await run(bin, ["g", "plugin", "installed-hook", "--type", "hook", "--event", "context.prepare"], project);
    for (const kind of ["agent", "tool", "controller", "session"])
      await run(bin, ["g", kind, "installed-example"], project);
    for (const type of ["basic", "tool", "provider", "storage", "capability"])
      await run(bin, ["g", "plugin", `installed-${type}`, "--type", type], project);
    await run(bin, ["g", "plugin", "installed-notification", "--type", "hook", "--event", "ready"], project);
    expect(await readFile(join(project, "src/plugins/installed-hook.ts"), "utf8")).toContain("context.prepare");
    const original = await readFile(join(project, "package.json"), "utf8");
    await expect(run(bin, ["new", "installed-app"], work)).rejects.toThrow();
    expect(await readFile(join(project, "package.json"), "utf8")).toBe(original);
    await linkSdk(project);
    await run(resolve("node_modules/typescript/bin/tsc"), ["--project", "tsconfig.json", "--noEmit"], project);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60000);

async function command(name: "npm" | "npx" | "pnpm", args: string[], cwd: string, cache: string) {
  const options = {
    cwd, windowsHide: true, timeout: 30000,
    env: { ...process.env, CI: "true", npm_config_offline: "true", npm_config_cache: cache },
  };
  let executable = name as string;
  if (process.platform === "win32") {
    const entry = name === "pnpm" ? "pnpm/bin/pnpm.mjs" : `npm/bin/${name}-cli.js`;
    const launcher = [dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)]
      .flatMap(path => [join(path, "node_modules", entry), join(path, "..", entry)])
      .find(existsSync);
    if (!launcher) throw Error(`Missing ${name} JavaScript CLI`);
    executable = process.execPath;
    args = [launcher, ...args];
  }
  return execute(executable, args, options).catch((error: { message: string; stdout?: string; stderr?: string; code?: number | string; signal?: string; killed?: boolean }) => {
    throw Error(`${error.message}\nexitCode=${error.code} signal=${error.signal} killed=${error.killed}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`);
  });
}
