import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { Agent, Controller } from "../../packages/core/dist/index.js";
import { ScriptedProvider } from "../../packages/core/dist/testing/index.js";
import { PluginManager } from "../../packages/plugins/dist/index.js";

const directory = await mkdtemp(join(tmpdir(), "tessar-agent-registration-"));
let controller;
const manager = new PluginManager({ directory, hostUrl: import.meta.url });
try {
  await mkdir(join(directory, "plugins"));
  await writeFile(join(directory, "plugins/research.mts"), `
    import { Agent, input, type Plugin, type PluginContext } from '@tessar/core';
    import { ScriptedProvider } from '@tessar/core/testing';
    class Research implements Plugin {
      readonly id = 'research';
      worker?: Agent;
      setup(tessar: PluginContext) {
        const worker = new Agent({ id: 'researcher', model: new ScriptedProvider([{ text: 'plugin worker answer' }]) });
        this.worker = worker;
        tessar.agent.register(worker);
        tessar.hook(input.prepare, async event => ({ ...event.payload, handled: { output: (await worker.generate('research')).output } }));
      }
    }
    export default new Research();
  `);
  const [plugin] = await manager.load();
  controller = new Controller({ id: "host", agent: new Agent({ id: "main", model: new ScriptedProvider([]) }), plugins: [plugin] });
  await controller.initialize();
  assert.ok(plugin.worker instanceof Agent, "plugin must use the host SDK constructor");
  assert.throws(() => new Agent({ id: "researcher", model: new ScriptedProvider([]) }), { code: "RegistrationConflict" });
  const result = await controller.agent.generate("hello");
  assert.equal(result.status, "completed");
  assert.equal(result.output[0].content[0].text, "plugin worker answer");
  await controller.plugins.detach(plugin.id);
  const replacement = new Agent({ id: "researcher", model: new ScriptedProvider([]) });
  await replacement.shutdown();
  console.log("PASS: external TypeScript plugin uses host Agent, registers and executes its own worker, and releases its ID on detach");
} finally {
  await controller?.dispose();
  manager.dispose();
  const cleanupTarget = await realpath(directory);
  const cleanupRelative = relative(await realpath(tmpdir()), cleanupTarget);
  assert.ok(cleanupRelative && !isAbsolute(cleanupRelative) && !cleanupRelative.startsWith('..'));
  await rm(cleanupTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
