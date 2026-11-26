import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AssistantMessage, HumanMessage, MessageCodec, TessarError, type PluginContext } from "@tessar/core";
import { AgentHarness } from "@tessar/core/testing";
import { createTool, type Tool } from "@tessar/core/tool";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApplyPatch, createEditFile, WorkspacePlugin, type PatchRecoveryDecision } from "../src/index.js";

const temporaryRoot = resolve(tmpdir());
const path = "orders.ts";
const input = { path, edits: [{ oldText: "pending", newText: "paid" }] };
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(temporaryRoot, "tessar-fs-recover-"));
  await writeFile(join(root, path), "const status = 'pending';\n");
});

afterEach(async () => {
  expect(resolve(root, "..")).toBe(temporaryRoot);
  await rm(root, { recursive: true, force: true });
});

it.each([
  { registration: "plugin", decision: "completed", previousStatus: "paid", executions: 1 },
  { registration: "direct", decision: "safeToRetry", previousStatus: "pending", executions: 2 },
] as const)("recovers the same stream after $decision is confirmed through $registration registration", async (scenario) => {
  const reconcileEdit = vi.fn(() => scenario.decision);
  const name = scenario.registration === "direct" ? "update_workspace_file" : "edit_file";
  let executions = 0;
  function interruptFirstCall(tool: Tool) {
    return createTool({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
      recovery: tool.recovery,
      async execute(input, context) {
        executions++;
        if (executions === 1) {
          if (scenario.decision === "completed") await tool.execute(input, context);
          throw new TessarError("StorageUnavailable", "Tool result was lost");
        }
        return tool.execute(input, context);
      },
    });
  }

  const plugin = new WorkspacePlugin(root, {
    tools: { apply_patch: false, edit_file: { reconcile: reconcileEdit } },
  });
  const harness = await AgentHarness.create({
    ...(scenario.registration === "plugin"
      ? { plugins: [{
          id: "fs",
          configurationId: plugin.configurationId,
          setup(tessar: PluginContext) {
            plugin.setup({ ...tessar, tools: { register: (tool) => tessar.tools.register(interruptFirstCall(tool)) } });
          },
        }] }
      : { tools: { [name]: interruptFirstCall(createEditFile({ root, reconcileEdit })) } }),
    modelScripts: [{ response: { message: MessageCodec.encode(new AssistantMessage([
      { type: "tool-call", toolCallId: "edit-order", name, arguments: input },
    ])) } }, { text: "done" }],
  });
  try {
    const thread = await harness.createThread();
    const stream = harness.admit({
      kind: "input",
      threadId: thread.id,
      input: [MessageCodec.encode(new HumanMessage("Update the order status"))],
      model: harness.provider.ref,
    });
    await expect(harness.collect(stream)).rejects.toThrow("Tool result was lost");
    const streamId = stream.id!;
    const record = (await harness.records(streamId)).tools[0]!;
    expect(record.idempotencyKey).toBe(record.id);
    expect(reconcileEdit).not.toHaveBeenCalled();

    if (scenario.registration === "plugin") {
      await harness.controller.plugins.detach("fs");
      await harness.controller.plugins.attach(plugin);
    }

    const session = await harness.controller.createSession();
    await session.thread.switch(thread.id);
    expect((await harness.records(streamId)).stream.status).toBe("interrupted");
    expect(await readFile(join(root, path), "utf8")).toContain(`'${scenario.previousStatus}'`);
    expect(executions).toBe(1);

    const completed = Promise.withResolvers<void>();
    const off = session.subscribe((event) => {
      if (event.type === "stream.end") completed.resolve();
      if (event.type === "stream.error") completed.reject(new Error(event.payload.error.message));
    });
    void completed.promise.catch(() => {});
    try {
      await session.recover({ streamId });
      await completed.promise;
    } finally {
      off();
    }
    const recovered = await harness.records(streamId);
    expect(recovered.stream.status).toBe("completed");
    expect(recovered.tools).toHaveLength(1);
    expect(recovered.tools[0]).toMatchObject({ id: record.id, status: "succeeded" });
    expect(recovered.tools[0]?.result?.content).toEqual([{ type: "text", text: "Edited orders.ts" }]);
    expect(await readFile(join(root, path), "utf8")).toBe("const status = 'paid';\n");
    expect(reconcileEdit).toHaveBeenCalledTimes(1);
    expect(reconcileEdit).toHaveBeenCalledWith({ toolExecutionId: record.id, ...input });
    expect(executions).toBe(scenario.executions);
  } finally {
    await harness.dispose();
  }
});

it("keeps the result unknown when the requested file is outside the workspace", async () => {
  const reconcileEdit = vi.fn(() => "completed" as const);
  const tool = createEditFile({ root, reconcileEdit });
  await expect(tool.recovery!.reconcile({ id: "edit-1", key: "edit-1", input: { ...input, path: "../orders.ts" } }))
    .resolves.toEqual({ status: "unknown" });
  expect(reconcileEdit).not.toHaveBeenCalled();
});

const patchFor = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const update = ["*** Update File: orders.ts", "@@", "-const status = 'pending';", "+const status = 'paid';"];
const patch = patchFor(...update, "*** Add File: orders.test.ts", "+// Order tests");

it.each([
  { registration: "plugin", decision: { status: "completed", paths: ["orders.test.ts", path] }, effect: "complete" },
  { registration: "direct", decision: { status: "safeToRetry" }, effect: "none" },
  { registration: "direct", decision: { status: "unknown" }, effect: "partial" },
] as const)("recovers a patch with $decision.status through $registration registration", async (scenario) => {
  const reconcilePatch = vi.fn((): PatchRecoveryDecision => scenario.decision);
  let executions = 0;
  function interruptFirstCall(tool: Tool) {
    return createTool({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
      recovery: tool.recovery,
      async execute(input, context) {
        if (++executions === 1) {
          if (scenario.effect !== "none")
            await tool.execute({ patch: scenario.effect === "partial" ? patchFor(...update) : patch }, context);
          throw new TessarError("StorageUnavailable", "Patch result was lost");
        }
        return tool.execute(input, context);
      },
    });
  }
  const name = scenario.registration === "plugin" ? "workspace_patch" : "direct_patch";
  const plugin = new WorkspacePlugin(root, {
    tools: { apply_patch: { name, reconcile: reconcilePatch }, edit_file: false },
  });
  const harness = await AgentHarness.create({
    ...(scenario.registration === "plugin"
      ? { plugins: [{
          id: plugin.id,
          configurationId: plugin.configurationId,
          setup(tessar: PluginContext) {
            plugin.setup({ ...tessar, tools: { register: (tool) => tessar.tools.register(interruptFirstCall(tool)) } });
          },
        }] }
      : { tools: { [name]: interruptFirstCall(createApplyPatch({ root, reconcilePatch })) } }),
    modelScripts: [{ response: { message: MessageCodec.encode(new AssistantMessage([
      { type: "tool-call", toolCallId: "patch-order", name, arguments: { patch } },
    ])) } }, { text: "done" }],
  });
  try {
    const thread = await harness.createThread();
    const stream = harness.admit({
      kind: "input",
      threadId: thread.id,
      input: [MessageCodec.encode(new HumanMessage("Update the order and add a test"))],
      model: harness.provider.ref,
    });
    await expect(harness.collect(stream)).rejects.toThrow("Patch result was lost");
    const streamId = stream.id!;
    const { tools: [record] } = await harness.records(streamId);
    expect(record?.idempotencyKey).toBe(record?.id);
    expect(reconcilePatch).not.toHaveBeenCalled();

    await harness.collect(harness.admit({ kind: "recover", threadId: thread.id, streamId }));
    expect(reconcilePatch).toHaveBeenCalledExactlyOnceWith({ toolExecutionId: record!.id, patch });
    expect(executions).toBe(scenario.effect === "none" ? 2 : 1);
    expect(await readFile(join(root, path), "utf8")).toContain("'paid'");
    const recovered = await harness.records(streamId);
    if (scenario.effect === "partial") {
      expect(recovered.stream.status).toBe("cancelled");
      await expect(readFile(join(root, "orders.test.ts"))).rejects.toHaveProperty("code", "ENOENT");
    } else {
      expect(recovered.stream.status).toBe("completed");
      expect(recovered.tools[0]?.result?.content).toEqual([
        { type: "data", data: { paths: [path, "orders.test.ts"] } },
      ]);
      expect(await readFile(join(root, "orders.test.ts"), "utf8")).toBe("// Order tests\n");
    }
  } finally {
    await harness.dispose();
  }
});

it("leaves an unsafe patch or an incomplete completion report unknown", async () => {
  const reconcilePatch = vi.fn((): PatchRecoveryDecision => ({ status: "completed", paths: [path] }));
  const tool = createApplyPatch({ root, reconcilePatch });
  const reconcile = (patch: string) =>
    tool.recovery?.reconcile({ id: "patch-1", key: "patch-1", input: { patch } });
  await expect(reconcile(patchFor("*** Add File: ../outside.ts", "+bad"))).resolves.toEqual({ status: "unknown" });
  expect(reconcilePatch).not.toHaveBeenCalled();
  await expect(reconcile(patch)).resolves.toEqual({ status: "unknown" });
  expect(reconcilePatch).toHaveBeenCalledOnce();
});
