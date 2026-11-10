import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
it("reads, splits and embeds standalone content and cancels HTTP loading through built exports", () => {
  const result = spawnSync(process.execPath, ["tests/fixtures/rag-consumer.ts"], {
    encoding: "utf8",
    timeout: 15000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
});
it("calls TypeSafe through built public exports and persists standalone decisions in SQLite", () => {
  const result = spawnSync(process.execPath, ["tests/fixtures/typesafe-consumer.ts"], { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
});
it("loads built core without product startup I/O and runs the public APIs", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
  import assert from 'node:assert/strict';
  globalThis.fetch=()=>{throw Error('Unexpected startup network');};
  const {Agent,Controller,Session,HumanMessage,tool:toolHooks,stream:streamHooks}=await import('@tessar/core');
  assert.equal(toolHooks.before,'tool.before');assert.equal(typeof Session,'function');
  const {createTool,Tool}=await import('@tessar/core/tool');
  const {z}=await import('zod');
  const core=await import('@tessar/core');
  assert.equal(createTool,core.createTool);assert.equal(Tool,core.Tool);
  const tool=createTool({name:'echo',description:'Echo input',schema:z.string(),execute:value=>value});
  assert.ok(tool instanceof core.Tool);
  assert.ok(await tool.execute('subpath works',{}) instanceof core.ToolMessage);
  assert.deepEqual((await tool.execute('subpath works',{})).content,[{type:'text',text:'subpath works'}]);
  const {ScriptedProvider}=await import('@tessar/core/testing');
  const provider=new ScriptedProvider([{text:'built answer'}]);
  const {PluginManager}=await import('@tessar/plugins');
  const manager=new PluginManager({directory:process.cwd(),hostUrl:import.meta.url});
  try{const [logger]=await manager.load(['@tessar/plugins/logger']);assert.equal(logger.id,'logger');assert.equal(typeof logger.setup,'function');}finally{manager.dispose();}
  const {LoggerPlugin,FileTransport,ConsoleTransport,logGroup}=await import('@tessar/plugins/logger');const logs=[];
  assert.equal(typeof FileTransport,'function');assert.equal(typeof ConsoleTransport,'function');assert.equal(logGroup.thread,'thread');
  const telemetry=await import('@tessar/opentelemetry');assert.deepEqual(Object.keys(telemetry).sort(),['LaminarAdapter','LangfuseAdapter','OTLPAdapter','OpenTelemetryPlugin']);assert.equal(new telemetry.OpenTelemetryPlugin({adapters:[new telemetry.OTLPAdapter()]}).id,'opentelemetry');
  const logger=new LoggerPlugin({transports:[{write:entry=>{logs.push(entry);}}]});assert.ok(logger instanceof LoggerPlugin);assert.ok(!('write' in logger));
  const agent=new Agent({id:'consumer',model:{providerId:'scripted',modelId:'test'}});
  const controller=new Controller({id:'consumer-runtime',agent,plugins:[logger,{id:'fixture',setup(tessar){tessar.models.register({id:'scripted',create:()=>provider});}}]});
  await controller.initialize();
  try{const result=await agent.generate(new HumanMessage('hello'));assert.equal(result.status,'completed');assert.equal(result.output[0].content[0].text,'built answer');assert.ok(logs.some(entry=>entry.type===streamHooks.end));}finally{await controller.dispose();}
 `,
    ],
    { encoding: "utf8" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
});

it("composes independent agents through a plugin using built public APIs", () => {
  const result = spawnSync(
    process.execPath,
    ["tests/fixtures/agent-composition.ts"],
    { encoding: "utf8" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
});

it("delivers signals through built public Stream and Session APIs", () => {
  const result = spawnSync(
    process.execPath,
    ["tests/fixtures/signal-consumer.ts"],
    { encoding: "utf8" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
});

it("exports traces through the built OpenTelemetry package using a local OTLP collector", () => {
  const result = spawnSync(
    process.execPath,
    ["tests/fixtures/opentelemetry-consumer.ts"],
    { encoding: "utf8" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
});
