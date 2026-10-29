import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { existsSync, type Dirent } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { isAbsolute, join, resolve, dirname, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Plugin } from "@tessar/core";

export interface PluginManagerOptions {
  directory: string;
  /** A host module URL from which public SDK imports resolve. */
  hostUrl?: string;
}
interface Manifest {
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}
interface PluginConfig {
  packages?: string[];
  [key: string]: unknown;
}
const extensions = [".mjs", ".js", ".cjs", ".mts", ".ts", ".cts"];
const isEntry = (name: string) =>
  extensions.some((ext) => name.endsWith(ext)) &&
  !/\.d\.(?:ts|mts|cts)$/.test(name);
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const execute = promisify(execFile);
const packageName =
  /^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9][a-z0-9._-]*)(?:@.+)?$/i;
function validName(name: string): void {
  if (packageName.exec(name)?.[1] !== name)
    throw Error("Invalid plugin package name: " + name);
}

/** Opt-in Node host utilities; PluginHost still owns setup and resource cleanup. */
export class PluginManager {
  readonly directory: string;
  private readonly npmDirectory: string;
  private readonly hostUrl: string;
  private readonly prefix = "tessar-plugin:" + randomUUID() + "/";
  private readonly graph = new Set<string>();
  private resolver?: ReturnType<typeof registerHooks>;
  private disposed = false;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(options: PluginManagerOptions) {
    if (!options.directory.trim())
      throw Error("Plugin directory must be nonempty");
    this.directory = resolve(options.directory);
    this.npmDirectory = join(this.directory, "npm");
    this.hostUrl = options.hostUrl ?? import.meta.url;
  }
  private check(): void {
    if (this.disposed) throw Error("PluginManager is disposed");
  }
  private async readJson<T>(filename: string): Promise<T> {
    let data: unknown;
    try {
      data = JSON.parse(await readFile(filename, "utf8"));
    } catch (error) {
      if (missing(error)) return {} as T;
      throw new Error("Invalid JSON file " + filename, { cause: error });
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw Error("Expected a JSON object in " + filename);
    return data as T;
  }
  private manifest(): Promise<Manifest> {
    return this.readJson(join(this.npmDirectory, "package.json"));
  }
  private async configuration(): Promise<PluginConfig> {
    const filename = join(this.directory, "plugins.json");
    const data = await this.readJson<PluginConfig>(filename);
    if (
      data.packages !== undefined &&
      (!Array.isArray(data.packages) ||
        data.packages.some(
          (value) => typeof value !== "string" || !value.trim(),
        ))
    )
      throw Error("Invalid packages in " + filename);
    return data;
  }
  async discover(): Promise<string[]> {
    this.check();
    const directory = join(this.directory, "plugins");
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (!missing(error)) throw error;
      entries = [];
    }
    const sources: string[] = [];
    for (const entry of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (entry.isFile() && isEntry(entry.name))
        sources.push(join(directory, entry.name));
      else if (entry.isDirectory()) {
        const files = await readdir(join(directory, entry.name));
        const indexes = extensions
          .map((ext) => "index" + ext)
          .filter((name) => files.includes(name));
        if (indexes.length > 1)
          throw Error("Ambiguous plugin entry: " + join(directory, entry.name));
        if (indexes[0]) sources.push(join(directory, entry.name, indexes[0]));
      }
    }
    const config = await this.configuration();
    this.check();
    return [...sources, ...(config.packages ?? [])];
  }
  private registerResolver(): void {
    if (this.resolver) return;
    this.resolver = registerHooks({
      resolve: (specifier, context, nextResolve) => {
        const sdkPrefix = this.prefix + "sdk/";
        if (specifier.startsWith(sdkPrefix))
          return nextResolve(
            decodeURIComponent(specifier.slice(sdkPrefix.length)),
            { ...context, parentURL: this.hostUrl },
          );
        if (specifier.startsWith(this.prefix)) {
          const source = decodeURIComponent(
            specifier.slice(this.prefix.length),
          );
          const result = nextResolve(source, {
            ...context,
            parentURL: pathToFileURL(join(this.npmDirectory, "package.json"))
              .href,
          });
          this.graph.add(result.url);
          return result;
        }
        if (context.parentURL && this.graph.has(context.parentURL)) {
          if (
            specifier === "@tessar/core" ||
            specifier.startsWith("@tessar/core/")
          )
            // Resolve through ESM: require's default resolver retains caller search paths.
            return {
              url: import.meta.resolve(
                sdkPrefix + encodeURIComponent(specifier),
              ),
              shortCircuit: true,
            };
          try {
            const result = nextResolve(specifier, context);
            this.graph.add(result.url);
            return result;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (
              (code !== "ERR_MODULE_NOT_FOUND" &&
                code !== "MODULE_NOT_FOUND") ||
              specifier.startsWith(".") ||
              isAbsolute(specifier) ||
              specifier.includes(":") ||
              specifier.startsWith("#")
            )
              throw error;
            // Custom files can also use dependencies in the managed npm environment.
            const url = context.conditions.includes("require")
              ? pathToFileURL(
                  createRequire(
                    join(this.npmDirectory, "package.json"),
                  ).resolve(specifier),
                ).href
              : import.meta.resolve(
                  this.prefix + encodeURIComponent(specifier),
                );
            this.graph.add(url);
            return {
              url,
              shortCircuit: true,
            };
          }
        }
        return nextResolve(specifier, context);
      },
    });
  }
  async load(sources?: readonly string[]): Promise<Plugin[]> {
    this.check();
    const entries = sources ?? (await this.discover());
    this.check();
    if (entries.length) this.registerResolver();
    const plugins: Plugin[] = [],
      ids = new Set<string>();
    for (const source of entries) {
      try {
        const specifier =
          isAbsolute(source) || source.startsWith(".")
            ? pathToFileURL(resolve(this.directory, source)).href
            : source;
        const module = await import(
          this.prefix + encodeURIComponent(specifier)
        );
        this.check();
        const plugin = module.default as Plugin | undefined;
        if (
          !plugin ||
          typeof plugin !== "object" ||
          typeof plugin.id !== "string" ||
          !plugin.id.trim() ||
          typeof plugin.setup !== "function"
        )
          throw Error(
            "Expected a default Plugin export with id and setup(tessar)",
          );
        if (ids.has(plugin.id))
          throw Error("Duplicate plugin ID: " + plugin.id);
        ids.add(plugin.id);
        plugins.push(plugin);
      } catch (error) {
        throw new Error(
          "Cannot load plugin " +
            source +
            ": " +
            (error instanceof Error ? error.message : String(error)),
          { cause: error },
        );
      }
    }
    return plugins;
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(() => {
      this.check();
      return operation();
    });
    this.mutation = next.catch(() => {});
    return next;
  }
  private async saveConfiguration(config: PluginConfig): Promise<void> {
    await writeFile(
      join(this.directory, "plugins.json"),
      JSON.stringify(config, null, 2) + "\n",
    );
  }
  private async npm(args: string[]): Promise<string> {
    const parameters = [
      ...args,
      "--prefix",
      this.npmDirectory,
      "--no-audit",
      "--no-fund",
    ];
    // Windows .cmd launchers require a shell; invoke npm's JS entry with Node instead.
    if (process.platform === "win32") {
      const directories = [
        dirname(process.execPath),
        ...(process.env.PATH ?? "").split(delimiter),
      ];
      const cli = directories
        .map((dir) => join(dir, "node_modules/npm/bin/npm-cli.js"))
        .find(existsSync);
      if (!cli) throw Error("npm is not installed alongside Node or on PATH");
      return (
        await execute(process.execPath, [cli, ...parameters], {
          cwd: this.npmDirectory,
          windowsHide: true,
        })
      ).stdout;
    } else
      return (
        await execute("npm", parameters, {
          cwd: this.npmDirectory,
          windowsHide: true,
        })
      ).stdout;
  }
  install(source: string, options: { name?: string } = {}): Promise<string> {
    return this.mutate(async () => {
      if (!source.trim() || source.startsWith("-"))
        throw Error("Invalid plugin source");
      const local =
        isAbsolute(source) ||
        source.startsWith(".") ||
        source.startsWith("file:");
      const target = local
        ? resolve(this.directory, source.replace(/^file:/, ""))
        : source;
      let sourceName = local
        ? (await stat(target)).isDirectory()
          ? (
              JSON.parse(
                await readFile(join(target, "package.json"), "utf8"),
              ) as { name?: string }
            ).name
          : undefined
        : packageName.exec(source)?.[1];
      const name = options.name ?? sourceName;
      if (typeof name !== "string")
        throw Error("Provide a package name for Git, tarball or URL sources");
      validName(name);
      const config = await this.configuration();
      await mkdir(this.npmDirectory, { recursive: true });
      if (!existsSync(join(this.npmDirectory, "package.json")))
        await writeFile(
          join(this.npmDirectory, "package.json"),
          JSON.stringify({ private: true, type: "module" }, null, 2) + "\n",
        );
      if (!sourceName) {
        const packed = JSON.parse(
          await this.npm([
            "pack",
            "--dry-run",
            "--ignore-scripts",
            "--json",
            target,
          ]),
        ) as { name?: string }[];
        sourceName = packed[0]?.name;
      }
      if (sourceName !== name)
        throw Error(
          "Requested name " +
            name +
            " differs from source package " +
            sourceName,
        );
      await this.npm(["install", "--save-exact", "--install-links", target]);
      const manifest = await this.manifest();
      if (!manifest.dependencies?.[name])
        throw Error(
          "Installed source did not provide requested package " + name,
        );
      config.packages = [...new Set([...(config.packages ?? []), name])];
      await this.saveConfiguration(config);
      return name;
    });
  }
  update(name?: string): Promise<void> {
    return this.mutate(async () => {
      const manifest = await this.manifest();
      const config = await this.configuration();
      const names = name
        ? [name]
        : (config.packages ?? []).filter(
            (value) => manifest.dependencies?.[value],
          );
      for (const value of names) {
        validName(value);
        if (
          !config.packages?.includes(value) ||
          !manifest.dependencies?.[value]
        )
          throw Error("Not an installed plugin: " + value);
      }
      if (names.length) await this.npm(["update", ...names]);
    });
  }
  remove(name: string): Promise<void> {
    return this.mutate(async () => {
      validName(name);
      const before = await this.manifest();
      const config = await this.configuration();
      if (!config.packages?.includes(name) || !before.dependencies?.[name])
        throw Error("Not an installed plugin: " + name);
      await this.npm(["uninstall", name]);
      config.packages = (config.packages ?? []).filter(
        (value) => value !== name,
      );
      await this.saveConfiguration(config);
    });
  }
  dispose(): void {
    this.disposed = true;
    this.resolver?.deregister();
    this.resolver = undefined;
    this.graph.clear();
  }
}
