import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { delimiter } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
const execute = promisify(execFile);
const COMMAND_TIMEOUT_MS = 60000;
const INSTALLED_CLI_TIMEOUT_MS = 180000;
const DEBUG_LOG_TAIL_LINES = 80;

it("installs packed libSQL without its optional driver or RAG peers", async () => {
  const root = await mkdtemp(join(tmpdir(), "tessar libsql standalone "));
  try {
    const packs = join(root, "packs"), host = join(root, "host"), cache = join(root, "cache");
    await mkdir(packs);
    await mkdir(host);
    await writeFile(join(host, "package.json"), JSON.stringify({ private: true, type: "module" }));
    const tarballs: string[] = [];
    for (const directory of ["packages/core", "plugins/database/libsql"]) {
      const packed = await command("pnpm", ["pack", "--config.ignore-scripts=true", "--json", "--pack-destination", packs], resolve(directory), cache);
      tarballs.push(resolve(packs, JSON.parse(packed.stdout).filename));
    }
    // Optional peers must not be installed before the application chooses them.
    await command("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
      ...tarballs, realpathSync(resolve("node_modules/zod"))], host, cache);
    expect(existsSync(join(host, "node_modules/@tessar/rag"))).toBe(false);
    expect(existsSync(join(host, "node_modules/libsql"))).toBe(false);
    const installed = JSON.parse(await readFile(join(host, "node_modules/@tessar/libsql/package.json"), "utf8"));
    expect(installed.dependencies?.["@tessar/core"]).toBeUndefined();
    expect(installed.peerDependencies["@tessar/core"]).toMatch(/^\^\d/);
    expect(existsSync(join(host, "node_modules/vitest"))).toBe(false);
    const coreManifest = JSON.parse(await readFile(join(host, "node_modules/@tessar/core/package.json"), "utf8"));
    expect(coreManifest.peerDependencies.vitest).toMatch(/^\^5\./);
    expect(coreManifest.peerDependenciesMeta.vitest.optional).toBe(true);
    expect(installed.dependencies?.["@tessar/rag"]).toBeUndefined();
    expect(installed.peerDependencies["@tessar/rag"]).toMatch(/^\^\d/);
    expect(installed.peerDependenciesMeta["@tessar/rag"].optional).toBe(true);
    expect(installed.dependencies?.libsql).toBeUndefined();
    expect(installed.peerDependenciesMeta.libsql.optional).toBe(true);
    // Supply the chosen native driver locally so the consumer test stays offline.
    await command("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
      realpathSync(resolve("plugins/database/libsql/node_modules/libsql"))], host, cache);
    await writeFile(join(host, "main.mjs"), `
      import assert from 'node:assert/strict';
      import {TessarError} from '@tessar/core';
      import * as storage from '@tessar/libsql';
      import Database from 'libsql';
      const database = new Database(':memory:');
      assert.deepEqual(Object.keys(storage).sort(), ['LibsqlStoragePlugin','createLibsqlBackend']);
      await assert.rejects(storage.createLibsqlBackend({database:null}), error => TessarError.isInstance(error));
      const backend = await storage.createLibsqlBackend({database});
      try {
        const record = await backend.records.append({namespace:'consumer',data:{ok:true}});
        assert.deepEqual((await backend.records.get('consumer',record.id)).data,{ok:true});
      } finally { await backend.close(); database.close(); }
      await assert.rejects(import('@tessar/libsql/vector'), error =>
        error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('@tessar/rag'));
    `);
    await execute(process.execPath, ["main.mjs"], { cwd: host, windowsHide: true });
    await writeFile(join(host, "consumer.ts"), `
      import {createLibsqlBackend,LibsqlStoragePlugin,type LibsqlStorageOptions} from '@tessar/libsql';
      import Database from 'libsql';
      const database=new Database(':memory:');
      const options:LibsqlStorageOptions={database};
      const backend=await createLibsqlBackend(options);await backend.close();
      new LibsqlStoragePlugin(options);database.close();
    `);
    await writeFile(join(host, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, module: "NodeNext", target: "ES2023", types: [] },
      files: ["consumer.ts"],
    }));
    await execute(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: host, windowsHide: true });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60000);
async function command(
  name: "npm" | "pnpm",
  args: string[],
  cwd: string,
  cache: string,
) {
  const options = {
    cwd,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
    env: {
      ...process.env,
      CI: "true",
      npm_config_offline: "true",
      npm_config_cache: cache,
    },
  };
  const detailed = (error: any): never => {
    const logs = join(cache, "_logs");
    const latest = existsSync(logs) ? readdirSync(logs).filter(name => name.endsWith("-debug-0.log")).sort().at(-1) : undefined;
    const debug = latest ? readFileSync(join(logs, latest), "utf8").split(/\r?\n/).slice(-DEBUG_LOG_TAIL_LINES).join("\n") : "";
    throw Error(error.message.split("\n")[0] + `\nexitCode=${error.code} signal=${error.signal} killed=${error.killed}\n` + error.stdout + "\n" + error.stderr + "\n" + debug);
  };
  if (process.platform !== "win32")
    return execute(name, args, options).catch(detailed);
  const entry = name === "npm" ? "npm/bin/npm-cli.js" : "pnpm/bin/pnpm.mjs";
  const cli = [
    dirname(process.execPath),
    ...(process.env.PATH ?? "").split(delimiter),
  ]
    .flatMap((path) => [
      join(path, "node_modules", entry),
      join(path, "..", entry),
    ])
    .find(existsSync);
  if (!cli) throw Error("Missing " + name + " JavaScript CLI");
  return execute(process.execPath, [cli, ...args], options).catch(detailed);
}
it.skipIf(process.platform !== "win32")(
  "launches pnpm from the action-setup .bin layout on Windows",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tessar action setup "));
    const previousPath = process.env.PATH;
    try {
      const bin = join(root, "node_modules/.bin"),
        source = join(root, "node_modules/pnpm/bin");
      await mkdir(bin, { recursive: true });
      await mkdir(source, { recursive: true });
      await writeFile(
        join(source, "pnpm.mjs"),
        "console.log(JSON.stringify(process.argv.slice(2)));",
      );
      process.env.PATH = bin;
      const result = await command(
        "pnpm",
        ["--version"],
        root,
        join(root, "cache"),
      );
      expect(JSON.parse(result.stdout)).toEqual(["--version"]);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
);
it("runs a packed installed CLI from another project and discovers a plugin added after installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tessar installed host "));
  try {
    const pluginDir = join(root, "project/.tessar/plugins");
    await mkdir(pluginDir, { recursive: true });
    const packs = join(root, "packs"),
      host = join(root, "host"),
      fixture = join(root, "fixture"),
      cache = join(root, "npm-cache");
    await mkdir(packs);
    await mkdir(host);
    await mkdir(fixture);
    await writeFile(
      join(host, "package.json"),
      JSON.stringify({ private: true }),
    );
    const coreVersion = JSON.parse(
      await readFile(resolve("packages/core/package.json"), "utf8"),
    ).version;
    const pluginsVersion = JSON.parse(
      await readFile(resolve("packages/plugins/package.json"), "utf8"),
    ).version;
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify({
        name: "tessar-test-host",
        version: "1.0.0",
        type: "module",
        bin: { "test-host": "main.mjs" },
        dependencies: {
          "@tessar/core": coreVersion,
          "@tessar/plugins": pluginsVersion,
        },
      }),
    );
    await writeFile(
      join(fixture, "main.mjs"),
      `#!/usr/bin/env node
   import {Agent,Controller,HumanMessage} from '@tessar/core';
   import {ScriptedProvider} from '@tessar/core/testing';
   import {PluginManager} from '@tessar/plugins';
   import {resolve} from 'node:path';
   const manager=new PluginManager({directory:resolve('.tessar'),hostUrl:import.meta.url});let controller;
   try{if(process.argv[2]==='plugins'){console.log(JSON.stringify(await manager.discover()));}
   else{const provider=new ScriptedProvider([{text:'fixture answer'}]);
    const agent=new Agent({id:'packed',model:{providerId:'scripted',modelId:'test'}});
    const userPlugins=await manager.load();
    controller=new Controller({id:'packed',agent,plugins:[{id:'provider',setup(tessar){tessar.models.register({id:'scripted',create:()=>provider});}},...userPlugins]});await controller.initialize();const result=await agent.generate(new HumanMessage('hello'));
    console.log(JSON.stringify({status:result.status,output:result.output.flatMap(m=>m.content).filter(p=>p.type==='text').map(p=>p.text).join('')}));
   }}finally{try{await controller?.dispose();}finally{manager.dispose();}}
  `,
    );
    const results = await Promise.allSettled(
      ["packages/core", "packages/plugins"].map(async (path) => {
        const packed = await command(
          "pnpm",
          // prepack would rewrite shared dist while other process tests import it.
          ["pack", "--config.ignore-scripts=true", "--json", "--pack-destination", packs],
          resolve(path),
          cache,
        );
        return resolve(packs, JSON.parse(packed.stdout).filename);
      }),
    );
    const tarballs = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const zodFixture = join(root, "zod");
    await cp(resolve("node_modules/zod"), zodFixture, {
      recursive: true,
      dereference: true,
    });
    const packedZod = await command(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", packs],
      zodFixture,
      cache,
    );
    tarballs.push(resolve(packs, JSON.parse(packedZod.stdout)[0].filename));
    const packedHost = await command(
      "npm",
      ["pack", "--json", "--pack-destination", packs],
      fixture,
      cache,
    );
    tarballs.push(resolve(packs, JSON.parse(packedHost.stdout)[0].filename));
    await command(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--omit=peer",
        "--loglevel=verbose",
        "--no-audit",
        "--no-fund",
        ...tarballs,
      ],
      host,
      cache,
    );
    const cli = join(host, "node_modules/tessar-test-host/main.mjs");
    const { stdout } = await execute(
      process.execPath,
      [cli, "hello", "--plugin-dir", join(root, "project/.tessar")],
      { cwd: join(root, "project") },
    );
    expect(JSON.parse(stdout).output).toBe("fixture answer");
    await writeFile(
      join(pluginDir, "answer.mts"),
      `import { Agent, input as inputHooks, type Plugin, type PluginContext } from '@tessar/core';
   import { ScriptedProvider } from '@tessar/core/testing';
   class AnswerPlugin implements Plugin {readonly id='installed-local';setup(tessar:PluginContext){
    const worker=new Agent({id:'external-worker',model:new ScriptedProvider([{text:'external plugin answer'}])});
    tessar.agent.register(worker);
    tessar.hook(inputHooks.prepare,async event=>({...event.payload,handled:{output:(await worker.generate('hello')).output}}));}}
   export default new AnswerPlugin();`,
    );
    const result = await execute(
      process.execPath,
      [cli, "hello", "--plugin-dir", join(root, "project/.tessar")],
      { cwd: join(root, "project") },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "completed",
      output: "external plugin answer",
    });
    const listed = await execute(
      process.execPath,
      [cli, "plugins", "list", "--plugin-dir", join(root, "project/.tessar")],
      { cwd: join(root, "project") },
    );
    expect(JSON.parse(listed.stdout)).toHaveLength(1);
    const demo = await execute(
      process.execPath,
      [resolve("tests/fixtures/apps/cli/dist/main.js"), "hello"],
      { cwd: join(root, "project") },
    );
    expect(JSON.parse(demo.stdout).output).toBe("external plugin answer");
    const localPackage = join(root, "project/local-package");
    await mkdir(localPackage);
    await writeFile(
      join(localPackage, "package.json"),
      JSON.stringify({
        name: "cli-local-plugin",
        version: "1.0.0",
        type: "module",
        exports: "./index.mjs",
      }),
    );
    await writeFile(
      join(localPackage, "index.mjs"),
      "class CliLocalPlugin {id='cli-local-plugin';setup(){}} export default new CliLocalPlugin();",
    );
    const installed = await execute(
      process.execPath,
      [
        resolve("tests/fixtures/apps/cli/dist/main.js"),
        "plugins",
        "install",
        "./local-package",
      ],
      {
        cwd: join(root, "project"),
        env: {
          ...process.env,
          npm_config_offline: "true",
          npm_config_cache: cache,
        },
      },
    );
    expect(JSON.parse(installed.stdout)).toEqual({
      installed: "cli-local-plugin",
    });
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}, INSTALLED_CLI_TIMEOUT_MS);
it("loads the packed logger subpath using the host SDK without installing core in the plugin environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "tessar logger "));
  try {
    const managed = join(root, "managed"),
      npmDirectory = join(managed, "npm"),
      cache = join(root, "cache");
    await mkdir(npmDirectory, { recursive: true });
    await writeFile(
      join(managed, "plugins.json"),
      JSON.stringify({ packages: ["@tessar/plugins/logger"] }),
    );
    await writeFile(
      join(npmDirectory, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    const packed = await command(
      "pnpm",
      ["pack", "--config.ignore-scripts=true", "--json", "--pack-destination", root],
      resolve("packages/plugins"),
      cache,
    );
    const tarball = resolve(root, JSON.parse(packed.stdout).filename);
    await command(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      npmDirectory,
      cache,
    );
    expect(existsSync(join(npmDirectory, "node_modules/@tessar/core"))).toBe(
      false,
    );
    expect(
      existsSync(
        join(
          npmDirectory,
          "node_modules/@tessar/plugins/node_modules/@tessar/core",
        ),
      ),
    ).toBe(false);
    await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
   import assert from 'node:assert/strict';
   import { Agent, Controller, HumanMessage, stream as streamHooks } from '@tessar/core';
   import {ScriptedProvider} from '@tessar/core/testing';
   import {PluginManager} from '@tessar/plugins';
   const manager=new PluginManager({directory:process.argv[1],hostUrl:import.meta.url});
   const original=console.error,logs=[];let controller;
   console.error=line=>{logs.push(JSON.parse(line));};
   try{
    const [logger]=await manager.load();assert.equal(logger.id,'logger');
    const provider=new ScriptedProvider([{text:'logger works'}]);
    const agent=new Agent({id:'logger-host',model:{providerId:'scripted',modelId:'test'}});
    controller=new Controller({id:'logger-controller',agent,plugins:[logger,{id:'provider',setup(tessar){tessar.models.register({id:'scripted',create:()=>provider});}}]});await controller.initialize();
    const result=await agent.generate(new HumanMessage('hello'));
    assert.equal(result.status,'completed');assert.equal(result.output[0].content[0].text,'logger works');
    assert.ok(logs.some(entry=>entry.type===streamHooks.end&&entry.agentId==='logger-host'&&entry.controllerId==='logger-controller'));
   }finally{try{await controller?.dispose();}finally{manager.dispose();console.error=original;}}
  `,
        managed,
      ],
      { cwd: resolve("."), timeout: 30000 },
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}, 60000);
it("validates a tarball's actual package name before activating an existing helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "tessar tarball "));
  try {
    const source = join(root, "source"),
      helper = join(root, "helper"),
      managed = join(root, "managed"),
      cache = join(root, "cache");
    await Promise.all([mkdir(source), mkdir(helper), mkdir(managed)]);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "tar-plugin",
        version: "1.0.0",
        type: "module",
        exports: "./index.mjs",
      }),
    );
    await writeFile(
      join(source, "index.mjs"),
      "export default {id:'tar-plugin',setup(){}};",
    );
    await writeFile(
      join(helper, "package.json"),
      JSON.stringify({
        name: "existing-helper",
        version: "1.0.0",
        main: "index.cjs",
      }),
    );
    await writeFile(join(helper, "index.cjs"), "module.exports={};");
    await mkdir(join(managed, "npm"));
    await writeFile(
      join(managed, "npm/package.json"),
      JSON.stringify({
        private: true,
        dependencies: { "existing-helper": "file:" + helper },
      }),
    );
    await writeFile(
      join(managed, "plugins.json"),
      JSON.stringify({ packages: [] }),
    );
    const packed = await command(
      "npm",
      ["pack", "--json", "--pack-destination", root],
      source,
      cache,
    );
    const tarball = resolve(root, JSON.parse(packed.stdout)[0].filename);
    await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
   import assert from 'node:assert/strict';
   const {PluginManager}=await import(process.argv[1]);const manager=new PluginManager({directory:process.argv[2]});
   try{await assert.rejects(manager.install(process.argv[3],{name:'existing-helper'}),/source package/);
    assert.deepEqual(await manager.discover(),[]);
    await manager.install(process.argv[3],{name:'tar-plugin'});
    assert.equal((await manager.load())[0].id,'tar-plugin');
   }finally{manager.dispose();}
  `,
        pathToFileURL(resolve("packages/plugins/dist/index.js")).href,
        managed,
        tarball,
      ],
      {
        timeout: 30000,
        env: {
          ...process.env,
          npm_config_offline: "true",
          npm_config_cache: cache,
        },
      },
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}, 60000);
