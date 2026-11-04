import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
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
    for (const name of ["core", "server"]) {
      const packed = await command(["pack", "--json", "--pack-destination", directory], resolve("packages", name));
      archives.push(resolve(directory, JSON.parse(packed.stdout).filename));
    }
    const project = join(directory, "application"); await mkdir(project);
    await writeFile(join(project, "package.json"), JSON.stringify({ private: true, type: "module", packageManager: "pnpm@11.5.3",
      dependencies: { "@tessar/core": `file:${archives[0]}`, "@tessar/server": `file:${archives[1]}`, zod: "4.6.7" } }));
    await command(["install", "--offline", "--ignore-scripts"], project);
    const manifest = JSON.parse(await readFile(join(project, "node_modules/@tessar/server/package.json"), "utf8"));
    expect(manifest.peerDependencies["@tessar/core"]).not.toContain("workspace:");
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@hono/node-server", "hono"]);
    expect(await readFile(join(project, "node_modules/@tessar/server/LICENSE"), "utf8")).toContain("Apache");
    await writeFile(join(project, "usage.ts"), `
import { Agent } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { Tessar, registerRoute, registerMiddleware, type RouteHandler, type MiddlewareHandler } from "@tessar/server";
const health: RouteHandler = c => c.json({ok:true});
const middleware: MiddlewareHandler = async (_, next) => { await next(); };
const host = new Tessar({ agents: [new Agent({id:"packed",model:new ScriptedProvider([])})], server:{port:0,
  routes:[registerRoute("/health", {method:"GET",handler:health})], middlewares:[registerMiddleware("*",middleware)]} });
await host.close();
`);
    await execute(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2023", "--module", "NodeNext", "usage.ts"], { cwd: project, windowsHide: true });
    await execute(process.execPath, ["usage.ts"], { cwd: project, windowsHide: true, timeout: 10000 });
  } finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"))) throw Error("Unsafe cleanup");
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}, 90000);
