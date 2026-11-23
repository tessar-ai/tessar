import { expect, test } from "vitest";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname } from "node:path";

const execute = promisify(execFile);
async function command(args: string[], cwd: string) {
  let executable = "pnpm";
  if (process.platform === "win32") {
    const launcher = [dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)]
      .flatMap(path => [join(path, "node_modules/pnpm/bin/pnpm.mjs"), join(path, "../pnpm/bin/pnpm.mjs")]).find(existsSync);
    if (!launcher) throw Error("Missing pnpm JavaScript CLI");
    executable = process.execPath; args = [launcher, ...args];
  }
  return execute(executable, args, { cwd, windowsHide: true, timeout: 45000, env: { ...process.env, CI: "true" } })
    .catch((error: { message: string; stdout?: string; stderr?: string }) => { throw Error(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`); });
}

test("server tarball installs independently and public declarations compile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tessar-server-package-"));
  try {
    const archives: string[] = [];
    for (const path of ["packages/core", "packages/server", "integrations/auth/api-key", "packages/cli"]) {
      await execute(process.execPath, [resolve("scripts/copy-license.mjs")], { cwd: resolve(path), windowsHide: true });
      const packed = await command(["pack", "--config.ignore-scripts=true", "--json", "--pack-destination", directory], resolve(path));
      archives.push(resolve(directory, JSON.parse(packed.stdout).filename));
    }
    const external: Record<string, string> = {};
    const zodPack = await command(["pack", "--config.ignore-scripts=true", "--config.manage-package-manager-versions=false", "--json", "--pack-destination", directory], realpathSync(resolve("node_modules/zod")));
    external.zod = `file:${resolve(directory, JSON.parse(zodPack.stdout).filename)}`;
    const project = join(directory, "application"); await mkdir(project);
    const workspaceServer = JSON.parse(await readFile(resolve("packages/server/package.json"), "utf8"));
    await writeFile(join(project, "package.json"), JSON.stringify({
      private: true, type: "module", packageManager: "pnpm@11.5.3",
      dependencies: { "@tessar/core": `file:${archives[0]}`, "@tessar/server": `file:${archives[1]}`, "@tessar/auth-api-key": `file:${archives[2]}`, "@tessar/cli": `file:${archives[3]}`, fastify: workspaceServer.dependencies.fastify, zod: external.zod }
    }));
    await writeFile(join(project, "pnpm-workspace.yaml"), JSON.stringify({ overrides: external }));
    await command(["install", "--prefer-offline", "--ignore-scripts"], project);
    const manifest = JSON.parse(await readFile(join(project, "node_modules/@tessar/server/package.json"), "utf8"));
    expect(manifest.peerDependencies["@tessar/core"]).not.toContain("workspace:");
    expect(manifest.exports["./standalone"]).toBeUndefined();
    for (const adapter of ["./hono", "./express", "./fastify", "./self-host"]) {
      expect(existsSync(join(project, "node_modules/@tessar/server", manifest.exports[adapter].import))).toBe(true);
      expect(existsSync(join(project, "node_modules/@tessar/server", manifest.exports[adapter].types))).toBe(true);
    }
    expect(Object.keys(manifest.dependencies)).toEqual(["fastify"]);
    expect(manifest.peerDependenciesMeta.hono.optional).toBe(true);
    const installed = await readdir(join(project, "node_modules/.pnpm"));
    expect(installed.some(name => /^(?:hono|@hono\+node-server|express|@nestjs\+core)@/.test(name))).toBe(false);
    const authManifest = JSON.parse(await readFile(join(project, "node_modules/@tessar/auth-api-key/package.json"), "utf8"));
    expect(authManifest.peerDependencies["@tessar/server"]).not.toContain("workspace:");
    expect(existsSync(join(project, "node_modules/jose"))).toBe(false);
    expect(await readFile(join(project, "node_modules/@tessar/server/LICENSE"), "utf8")).toContain("Apache");
    await writeFile(join(project, "usage.ts"), `
import { Agent } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { ApiKeyAuth } from "@tessar/auth-api-key";
import { Tessar, TessarServerAdapter } from "@tessar/server";
import Fastify from "fastify";
import { TessarServer as FastifyServer } from "@tessar/server/fastify";
import type { TessarRequestHandler } from "@tessar/server";
const tessar = new Tessar({ agents: [new Agent({id:"packed",model:new ScriptedProvider([])})], server:{port:0,
  auth: { provider: new ApiKeyAuth({ key: "packed-key", identity: { id: "packed-user" } }), scope: user => ({ userId: user.id }) } } });
class Adapter extends TessarServerAdapter<{ handler?: TessarRequestHandler }> {
  protected registerHandler(handler: TessarRequestHandler) { this.app.handler = handler; }
}
const app: { handler?: TessarRequestHandler } = {};
const host = new Adapter({ app, tessar });
await host.init();
if ((await app.handler!(new Request("http://test/api/agents"))).status !== 401) throw new Error("Auth bypass");
if ((await app.handler!(new Request("http://test/api/agents", { headers: { authorization: "Bearer packed-key" } }))).status !== 200) throw new Error("Auth failed");
await host.shutdown();
const fastify = Fastify();
const integrated = new FastifyServer({ app: fastify, tessar, prefix: "/tessar" });
await integrated.init();
const result = await fastify.inject({ url: "/tessar/api/agents", headers: { authorization: "Bearer packed-key" } });
if (result.statusCode !== 200 || result.json()[0].id !== "packed") throw new Error("Fastify adapter failed");
await fastify.close();
await tessar.shutdown();
`);
    await execute(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2023", "--module", "NodeNext", "usage.ts"], { cwd: project, windowsHide: true });
    await execute(process.execPath, ["usage.ts"], { cwd: project, windowsHide: true, timeout: 10000 });
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src/index.ts"), `
import { Agent } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { Tessar } from "@tessar/server";
export default new Tessar({ agents: [new Agent({ id: "packed", model: new ScriptedProvider([]) })],
  server: { port: 0, configure(app) {
    app.register(async plugin => { plugin.get("/health", async () => ({ status: "fastify" })); });
  } },
});
`);
    const cli = spawn(process.execPath, [join(project, "node_modules/@tessar/cli/dist/bin.js"), "dev"], {
      cwd: project, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    });
    const exited = new Promise<number | null>((resolve, reject) => { cli.once("exit", resolve); cli.once("error", reject); });
    let stdout = "", stderr = "";
    cli.stdout!.on("data", chunk => { stdout += chunk; });
    cli.stderr!.on("data", chunk => { stderr += chunk; });
    try {
      await expect.poll(() => stdout.match(/Tessar listening at (http:\/\/[^\s]+)/)?.[1], { timeout: 10000 }).toBeTruthy();
      const baseURL = stdout.match(/Tessar listening at (http:\/\/[^\s]+)/)![1];
      expect(await fetch(baseURL + "/health").then(response => response.json())).toEqual({ status: "fastify" });
      expect(await fetch(baseURL + "/api/agents").then(response => response.json())).toMatchObject([{ id: "packed" }]);
    } finally {
      if (cli.connected) cli.send("shutdown");
      expect(await exited, stderr).toBe(0);
    }
  } finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"))) throw Error("Unsafe cleanup");
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}, 90000);
