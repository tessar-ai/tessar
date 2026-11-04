import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PluginManager } from "../src/plugin-manager.js";

const execute = promisify(execFile);

it.each(["named", "all"])("updates %s registry plugins beyond exact pins while preserving local sources", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "tessar-plugin-update-"));
  const manager = new PluginManager({ directory: root });
  const name = "tessar-update-fixture";
  const archives = new Map<string, Buffer>();
  let latest = "1.0.0";
  let registry = "";
  const server = createServer((request, response) => {
    const archive = archives.get(request.url ?? "");
    if (archive) return void response.end(archive);
    if (request.url !== "/" + name) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      name,
      "dist-tags": { latest },
      versions: Object.fromEntries(["1.0.0", "1.0.1"].map((version) => [
        version,
        { name, version, dist: { tarball: registry + version + ".tgz" } },
      ])),
    }));
  });
  const environment = {
    npm_config_registry: "",
    npm_config_cache: join(root, "cache"),
    npm_config_ignore_scripts: "true",
    npm_config_offline: "false",
    npm_config_update_notifier: "false",
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  try {
    for (const version of ["1.0.0", "1.0.1"]) {
      const directory = join(root, version);
      await mkdir(join(directory, "package"), { recursive: true });
      await writeFile(join(directory, "package/package.json"), JSON.stringify({ name, version }));
      const archive = join(root, version + ".tgz");
      await execute("tar", ["-czf", archive, "-C", directory, "package"]);
      archives.set("/" + version + ".tgz", await readFile(archive));
    }
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing registry port");
    registry = `http://127.0.0.1:${address.port}/`;
    Object.assign(process.env, environment, { npm_config_registry: registry });
    await manager.install(name);
    const local = join(root, "local");
    await mkdir(local);
    await writeFile(
      join(local, "package.json"),
      JSON.stringify({ name: "local-plugin", version: "1.0.0" }),
    );
    await manager.install(local);
    const manifestPath = join(root, "npm/package.json");
    const before = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(before.dependencies[name]).toBe("1.0.0");
    before.dependencies.helper = before.dependencies["local-plugin"];
    await writeFile(manifestPath, JSON.stringify(before));
    const configPath = join(root, "plugins.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.other = "preserved";
    await writeFile(configPath, JSON.stringify(config));
    const configuration = await readFile(configPath, "utf8");
    latest = "1.0.1";
    await manager.update(mode === "named" ? name : undefined);
    const after = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(after.dependencies[name]).toBe("1.0.1");
    const installed = JSON.parse(await readFile(
      join(root, "npm/node_modules", name, "package.json"), "utf8",
    ));
    expect(installed.version).toBe("1.0.1");
    expect(after.dependencies["local-plugin"]).toBe(before.dependencies["local-plugin"]);
    expect(after.dependencies.helper).toBe(before.dependencies.helper);
    expect(await readFile(configPath, "utf8")).toBe(configuration);
  } finally {
    manager.dispose();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30000);
