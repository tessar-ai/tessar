import { input as inputHooks, stream as streamHooks } from "@tessar/core";
import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { delimiter } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
const execute = promisify(execFile);
async function command(
  name: "npm" | "pnpm",
  args: string[],
  cwd: string,
  cache: string,
) {
  const options = {
    cwd,
    timeout: 30000,
    windowsHide: true,
    env: {
      ...process.env,
      CI: "true",
      npm_config_offline: "true",
      npm_config_cache: cache,
    },
  };
  const detailed = (error: any): never => {
    throw Error(error.message + "\n" + error.stdout + "\n" + error.stderr);
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
}, 60000);
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
