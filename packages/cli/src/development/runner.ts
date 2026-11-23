import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { TessarCLIError, CLI_ERROR_CODE } from "../errors.js";

const RUNTIME_MODULE = "tessar:runtime";
const SELF_HOST_MODULE = "tessar:self-host";
const entry = pathToFileURL(resolve("src/index.ts"));
let host: { shutdown(): Promise<void> } | undefined;
let tessar: { shutdown(): Promise<void> } | undefined;
let closing = false;
let disposal: Promise<void> | undefined;
const shutdown = () => {
  closing = true;
  return disposal ??= (async () => {
    try { await host?.shutdown(); }
    finally {
      try { await tessar?.shutdown(); }
      finally { hooks.deregister(); if (process.connected) process.disconnect(); }
    }
  })();
};
// Source projects follow the repository's ESM .js import convention.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === RUNTIME_MODULE || specifier === SELF_HOST_MODULE)
      return next(specifier === RUNTIME_MODULE ? "@tessar/server" : "@tessar/server/self-host", { ...context, parentURL: entry.href });
    try { return next(specifier, context); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND" || !context.parentURL || !specifier.startsWith(".") || !specifier.endsWith(".js")) throw error;
      const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (!existsSync(source)) throw error;
      return next(source.href, context);
    }
  }
});

process.on("message", message => { if (message === "shutdown") { closing = true; if (host) void shutdown().catch(fail); } });
process.once("SIGINT", () => { closing = true; if (host) void shutdown().catch(fail); });
process.once("SIGTERM", () => { closing = true; if (host) void shutdown().catch(fail); });
process.once("disconnect", () => { closing = true; if (host) void shutdown().catch(fail); });
function fail(error: unknown): void { console.error(error); process.exitCode = 1; }

try {
  if (existsSync(resolve(".env"))) loadEnvFile(resolve(".env"));
  if (!existsSync(entry)) throw new TessarCLIError(CLI_ERROR_CODE.INVALID_PROJECT, "Expected src/index.ts with a default Tessar export");
  const module = await import(entry.href);
  const { Tessar } = await import(RUNTIME_MODULE);
  if (!(module.default instanceof Tessar)) throw new TessarCLIError(CLI_ERROR_CODE.INVALID_PROJECT, "src/index.ts must default-export a Tessar instance");
  tessar = module.default;
  if (!closing) {
    const { startSelfHost } = await import(SELF_HOST_MODULE).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
      throw new TessarCLIError(CLI_ERROR_CODE.INVALID_PROJECT, "Upgrade @tessar/server to a version compatible with this CLI");
    });
    const server = await startSelfHost(module.default);
    host = server;
    console.log(`Tessar listening at ${server.url}`);
  }
  if (closing) await shutdown();
} catch (error) {
  fail(error);
  await shutdown().catch(fail);
}
