import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, AssistantMessage, MessageCodec } from "@tessar/core";
import { AgentHarness, ScriptedProvider } from "@tessar/core/testing";
import type { ToolExecutionContext } from "@tessar/core/tool";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WorkspacePlugin, TessarWorkspaceError, createApplyPatch, createEditFile } from "../src/index.js";

const temporaryRoot = resolve(tmpdir());
const context = { signal: new AbortController().signal } as ToolExecutionContext;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(temporaryRoot, "tessar-edit-"));
});

afterEach(async () => {
  expect(resolve(root, "..")).toBe(temporaryRoot);
  await rm(root, { recursive: true, force: true });
});

it("registers the renamed edit tool, disables apply_patch and edits the original file", async () => {
  const path = "order.ts";
  await writeFile(join(root, path), "pending: 1\npaid: 2\nkeep: 3\n");
  const edits = [{ oldText: "pending", newText: "paid" }, { oldText: "paid", newText: "archived" }];
  const response = MessageCodec.encode(new AssistantMessage([
    { type: "tool-call", toolCallId: "edit-order", name: "update_file", arguments: { path, edits } },
  ]));
  const harness = await AgentHarness.create({
    plugins: [new WorkspacePlugin(root, {
      tools: { apply_patch: false, edit_file: { name: "update_file" }, read_file: false, exec_command: false },
    })],
    modelScripts: [{ response: { message: response } }, { text: "done" }],
  });
  try {
    const result = await harness.agent.generate("Edit the order source file");
    expect(result.status).toBe("completed");
    expect(harness.provider.calls[0]?.tools.map((tool) => tool.name)).toEqual(["update_file"]);
    expect(result.output.find((message) => message.role === "tool")?.content).toEqual([
      { type: "text", text: "Edited order.ts" },
    ]);
    expect(await readFile(join(root, path), "utf8")).toBe("paid: 1\narchived: 2\nkeep: 3\n");
  } finally {
    await harness.dispose();
  }
});

it("matches LF input in a CRLF file while preserving the BOM and untouched bytes", async () => {
  const path = "order.ts";
  const target = join(root, path);
  await writeFile(target, "\uFEFFfirst\r\nsecond\r\nkeep\nlast");
  await createEditFile({ root }).execute({ path, edits: [
    { oldText: "first\nsecond", newText: "mới\nsecond" },
    { oldText: "last", newText: "" },
  ] }, context);
  expect(await readFile(target, "utf8")).toBe("\uFEFFmới\r\nsecond\r\nkeep\n");
});

it("checks all edits and rejects overlap, missing text and ambiguous text before writing", async () => {
  const path = "order.ts";
  const target = join(root, path);
  const existing = "first second third\nrepeat\nrepeat\n";
  await writeFile(target, existing);
  const edit = createEditFile({ root });
  for (const oldText of ["second third", "absent", "repeat"]) {
    await expect(edit.execute({ path, edits: [
      { oldText: "first second", newText: "updated" }, { oldText, newText: "replacement" },
    ] }, context)).rejects.toHaveProperty("code", "InvalidEdit");
    expect(await readFile(target, "utf8")).toBe(existing);
  }
});

it("requires an existing workspace file and respects abort before writing", async () => {
  const edit = createEditFile({ root });
  const edits = [{ oldText: "before", newText: "after" }];
  for (const path of ["../order.ts", "\uD800.ts", "missing.ts"]) {
    await expect(edit.execute({ path, edits }, context)).rejects.toBeInstanceOf(TessarWorkspaceError);
  }
  await writeFile(join(root, "order.ts"), "before");
  await expect(edit.execute({ path: "order.ts", edits }, {
    ...context, signal: AbortSignal.abort(),
  })).rejects.toHaveProperty("name", "AbortError");
  expect(await readFile(join(root, "order.ts"), "utf8")).toBe("before");
  await expect(readFile(join(root, "missing.ts"))).rejects.toHaveProperty("code", "ENOENT");
});

it("applies a patch after an earlier targeted edit to the same workspace", async () => {
  const path = "order.ts";
  await writeFile(join(root, path), "original\n");
  const patch = ["*** Begin Patch", `*** Update File: ${path}`, "@@", "-new", "+patched", "*** End Patch"].join("\n");
  const apply = createApplyPatch({ root });
  expect(apply.name).toBe("apply_patch");
  await Promise.all([
    createEditFile({ root }).execute({ path, edits: [{ oldText: "original", newText: "new" }] }, context),
    apply.execute({ patch }, context),
  ]);
  expect(await readFile(join(root, path), "utf8")).toBe("patched\n");
});

it("runs both native tools on an Agent without the filesystem plugin", async () => {
  const path = "order.ts";
  await writeFile(join(root, path), "original\n");
  const call = (name: string, args: Record<string, string | { oldText: string; newText: string }[]>) => ({
    response: { message: MessageCodec.encode(new AssistantMessage([
      { type: "tool-call", toolCallId: name, name, arguments: args },
    ])) },
  });
  const agent = new Agent({
    id: "standalone-files",
    tools: { edit_file: createEditFile({ root }), apply_patch: createApplyPatch({ root }) },
    model: new ScriptedProvider([
      call("edit_file", { path, edits: [{ oldText: "original", newText: "edited" }] }),
      call("apply_patch", { patch: "*** Begin Patch\n*** Update File: order.ts\n@@\n-edited\n+patched\n*** End Patch" }),
      { text: "done" },
    ]),
  });
  try {
    const result = await agent.generate("Update the order file");
    expect(result.status).toBe("completed");
    expect(result.output.filter(({ role }) => role === "tool").map(({ content }) => content)).toEqual([
      [{ type: "text", text: "Edited order.ts" }],
      [{ type: "data", data: { paths: ["order.ts"] } }],
    ]);
    expect(await readFile(join(root, path), "utf8")).toBe("patched\n");
  } finally {
    await agent.shutdown();
  }
});
