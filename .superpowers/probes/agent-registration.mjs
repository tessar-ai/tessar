// Read-only runtime probe: npm packages are built from the current checkout.
// Does not implement any proposed public API or call a live provider.
import assert from "node:assert/strict";
import { Agent, Controller, AssistantMessage, HumanMessage, MessageCodec, ThreadService, createTool } from "../../packages/core/dist/index.js";
import { PluginHost } from "../../packages/core/dist/plugins/host.js";
import { z } from "zod";

function model(id) {
  return {
    ref: { providerId: id, modelId: "fixture" }, calls: [],
    validate() {},
    async *stream(request) {
      this.calls.push(request);
      yield { type: "response", response: { message: MessageCodec.encode(new AssistantMessage(id)) } };
    },
  };
}
function tool(name) {
  return createTool({ name, description: name, schema: z.object({}), execute: () => name });
}
const observations = [];
const rootModel = model("assistant-provider"), workerModel = model("researcher-provider");
const assistant = new Agent({ id: "assistant", model: rootModel, tools: { root: tool("root_only") } });
const researcher = new Agent({ id: "researcher", model: workerModel, tools: { worker: tool("worker_only") } });
const controller = new Controller({ id: "probe", agent: assistant });
await controller.initialize();
try {
  assert.equal((await assistant.generate("root")).status, "completed");
  assert.equal((await researcher.generate("worker standalone")).status, "completed");
  assert.deepEqual(rootModel.calls[0].tools.map(t => t.name), ["root_only"]);
  assert.deepEqual(workerModel.calls[0].tools.map(t => t.name), ["worker_only"]);
  observations.push({ case: "independent-agent-loops", result: "pass", models: [rootModel.ref.providerId, workerModel.ref.providerId] });

  // Bypass the public limitation only to expose what routing also has to solve.
  // admit(..., runtime) is internal, not a proposed public subagent API.
  const thread = await new ThreadService(controller.backend).create();
  const stream = researcher.admit({ kind: "input", threadId: thread.id, input: [MessageCodec.encode(new HumanMessage("shared runtime"))], model: workerModel.ref }, { kind: "iterator" }, undefined, controller);
  const events = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "stream.error") throw Error(event.payload.error.message);
  }
  assert.equal(events.find(e => e.type === "stream.started").agentId, "researcher");
  const sharedTools = workerModel.calls.at(-1).tools.map(t => t.name);
  assert.deepEqual(sharedTools, ["root_only"]);
  observations.push({ case: "shared-runtime-without-agent-scoping", result: "gap-confirmed", expectedTools: ["worker_only"], actualTools: sharedTools, eventAgentId: "researcher" });

  // Current low-level registry already rejects duplicates across host/plugin inputs.
  const values = [assistant, researcher].map(agent => ({ kind: "agent", id: agent.id, value: agent, version: 1, pluginId: "host", pluginVersion: 1, configurationId: null }));
  const host = new PluginHost({ values });
  try {
    await assert.rejects(host.attach({ id: "duplicate", setup(tessar) { tessar.registry.register("agent", "researcher", researcher); } }), error => error.code === "RegistrationConflict");
    const lease = host.capture();
    try {
      assert.equal(lease.find("agent", "assistant"), assistant);
      assert.equal(lease.find("agent", "researcher"), researcher);
    } finally { await lease.release(); }
    observations.push({ case: "shared-id-namespace", result: "pass", duplicateCode: "RegistrationConflict" });
  } finally { await host.dispose(); }
} finally { await controller.dispose(); await researcher.shutdown(); }
console.log(JSON.stringify(observations, null, 2));
