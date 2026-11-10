import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, delimiter, sep } from "node:path";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const execute = promisify(execFile);
const COMMAND_TIMEOUT_MS = 45000;
const DISTRIBUTION_TIMEOUT_MS = 90000;
const CLEANUP_MAX_RETRIES = 5;
async function command(args: string[], cwd: string) {
  let executable = "pnpm";
  if (process.platform === "win32") {
    const launcher = [dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)]
      .flatMap(path => [join(path, "node_modules/pnpm/bin/pnpm.mjs"), join(path, "../pnpm/bin/pnpm.mjs")]).find(existsSync);
    if (!launcher) throw Error("Missing pnpm JavaScript CLI");
    executable = process.execPath; args = [launcher, ...args];
  }
  return execute(executable, args, { cwd, windowsHide: true, timeout: COMMAND_TIMEOUT_MS, env: { ...process.env, CI: "true" } })
    .catch((error: { message: string; stdout?: string; stderr?: string }) => { throw Error(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`); });
}

test("client tarball installs alone without core, server or zod and bundles without Node globals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tessar-client-package-"));
  try {
    const archives: string[] = [];
    for (const name of ["client"]) {
      const packed = await command(["pack", "--config.ignore-scripts=true", "--json", "--pack-destination", directory], resolve("packages", name));
      archives.push(resolve(directory, JSON.parse(packed.stdout).filename));
    }
    const project = join(directory, "application"); await mkdir(project);
    await writeFile(join(project, "package.json"), JSON.stringify({
      private: true, type: "module", packageManager: "pnpm@11.5.3",
      dependencies: { "@tessar/client": `file:${archives[0]}` }
    }));
    await command(["install", "--offline", "--ignore-scripts"], project);
    expect(existsSync(join(project, "node_modules/@tessar/server"))).toBe(false);
    expect(existsSync(join(project, "node_modules/@tessar/core"))).toBe(false);
    expect(existsSync(join(project, "node_modules/zod"))).toBe(false);
    const manifest = JSON.parse(await readFile(join(project, "node_modules/@tessar/client/package.json"), "utf8"));
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual([]);
    expect(await readFile(join(project, "node_modules/@tessar/client/LICENSE"), "utf8")).toContain("Apache");
    const entry = join(project, "usage.ts");
    await writeFile(entry, `
import { TessarClient, TessarClientError, type StateEvent } from "@tessar/client";
const client = new TessarClient({ baseURL: "https://test/tessar", fetch: async () => Response.json([{id:"agent"}]) });
if ((await client.listAgents())[0]?.id !== "agent") throw Error("Client failed");
const streamEvent = null as unknown as StateEvent;
const error = new TessarClientError("Example", "message");
if (error.toJSON().code !== "Example") throw Error("Error failed");
export { TessarClient, TessarClientError };
`);
    await execute(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--module", "NodeNext", "--target", "ES2023", entry], { cwd: project, windowsHide: true });
    await execute(process.execPath, ["--experimental-transform-types", entry], { cwd: project, windowsHide: true });

    // Reuse the installed Vite toolchain, not a production SDK dependency.
    const require = createRequire(import.meta.url);
    const viteRequire = createRequire(createRequire(require.resolve("vitest/package.json")).resolve("vite/package.json"));
    const bundler = await import(pathToFileURL(viteRequire.resolve("rolldown")).href);
    const bundle = await bundler.rolldown({ input: join(project, "node_modules/@tessar/client/dist/index.js"), platform: "browser", onwarn(warning: { message: string }) { throw Error(warning.message); } });
    try {
      const { output } = await bundle.generate({ format: "iife", name: "TessarSDK" });
      const code = output.map((chunk: { code?: string }) => chunk.code ?? "").join("\n");
      expect(code).not.toMatch(/\b(?:require\s*\(|process\.|Buffer\.|node:)/);
      const sandbox = { URL, Headers, Response, Request, TextDecoder, AbortController, console };
      const sdk = runInNewContext(code + "\nTessarSDK", sandbox);
      const calls: RequestInit[] = [];
      const client = new sdk.TessarClient({ baseURL: "https://test/tessar", credentials: "include", headers: { Authorization: "test" }, fetch: async (_: string, options: RequestInit) => { calls.push(options); return Response.json([{ id: "browser-agent" }]); } });
      expect(await client.listAgents()).toEqual([{ id: "browser-agent" }]);
      expect(calls[0]!.credentials).toBe("include");
      expect(new Headers(calls[0]!.headers).get("authorization")).toBe("test");
    } finally { await bundle.close(); }
  } finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe cleanup");
    await rm(directory, { recursive: true, force: true, maxRetries: CLEANUP_MAX_RETRIES });
  }
}, DISTRIBUTION_TIMEOUT_MS);
