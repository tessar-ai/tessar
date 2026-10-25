import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import * as core from "../src/index.js";
import * as tools from "../src/tools/index.js";
import { ScriptedProvider } from "../src/testing/scripted-provider.js";

// @ts-expect-error Runtime orchestration is not part of the application SDK.
import type { ExecutionFrame, PluginHost } from "../src/index.js";
// @ts-expect-error Child orchestration protocols are not part of the core SDK.
import type { ChildReservation } from "../src/index.js";

it("provides Agent Controller and Session directly from the core package", () => {
  expect(typeof (core as any).Agent).toBe("function");
  expect(typeof (core as any).Controller).toBe("function");
  expect(typeof (core as any).Session).toBe("function");
  expect("AgentEngine" in core).toBe(false);
});

it("reads Agent defaults without initialization or changing them during execution", async () => {
  const model = new ScriptedProvider([{ text: "answer" }]);
  const tool = core.createTool({
    name: "lookup",
    description: "Look up a record",
    schema: z.object({}),
    execute: () => "found",
  });
  const instructions = core.buildInstruction([
    { id: "base", content: "Be concise." },
  ]);
  const agent = new core.Agent({
    id: randomUUID(),
    model,
    tools: { lookup: tool },
    instructions,
  });
  try {
    expect(agent.listTool()).toEqual([tool]);
    expect(agent.getModel()).toBe(model);
    expect(agent.getInstruction()).toEqual(instructions);
    expect(agent.limits()).toEqual({
      maxTurns: 32,
      maxModelAttempts: 64,
      maxToolCalls: 128,
    });
    expect(Object.isFrozen(agent.limits())).toBe(true);
    expect(model.calls).toHaveLength(0);
    const concrete: ScriptedProvider = agent.getModel();
    expect(concrete).toBe(model);
    if (false) {
      // @ts-expect-error Agent configuration is read through methods.
      agent.model;
      // @ts-expect-error Agent configuration is read through methods.
      agent.tools;
      // @ts-expect-error Agent configuration is read through methods.
      agent.instructions;
    }
    await agent.generate("hello", { model: "alternate" });
    expect(agent.getModel()).toBe(model);
    expect(agent.getModel().ref.modelId).toBe("test");
    expect(agent.getInstruction()).toEqual(instructions);
  } finally {
    await agent.shutdown();
  }
});

it("keeps runtime construction helpers out of the package entrypoint", () => {
  expect(tools.createTool).toBe(core.createTool);
  expect(tools).not.toHaveProperty("normalizeToolOutput");
  for (const name of [
    "PluginHost",
    "RegistryLease",
    "CommitCoordinator",
    "StateQueries",
    "ThreadService",
    "ForkService",
    "PluginStateAccess",
    "EffectService",
    "childStateDefinition",
    "Suspension",
    "ModelRegistry",
    "inputMessages",
    "createModelAttempt",
    "normalizeToolOutput",
    "hookKinds",
    "StateView",
    "stateTool",
  ])
    expect(core).not.toHaveProperty(name);
  for (const name of [
    "Agent",
    "Controller",
    "Session",
    "Thread",
    "createTool",
    "buildInstruction",
    "defineEffect",
    "defineInterruption",
  ]) {
    expect(core).toHaveProperty(name);
  }
});
