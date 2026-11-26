import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AssistantMessage, MessageCodec } from "@tessar/core";
import { AgentHarness } from "@tessar/core/testing";
import type { ToolExecutionContext } from "@tessar/core/tool";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WorkspacePlugin, TessarWorkspaceError, createApplyPatch } from "../src/index.js";

let directory: string;
let root: string;
const context = { signal: new AbortController().signal } as ToolExecutionContext;
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const temporaryRoot = resolve(tmpdir());

beforeEach(async () => {
  directory = await mkdtemp(join(temporaryRoot, "tessar-fs-"));
  root = join(directory, "workspace");
  await mkdir(root);
});

afterEach(async () => {
  expect(resolve(directory, "..")).toBe(temporaryRoot);
  await rm(directory, { recursive: true, force: true });
});

it.each([
  [undefined, ["apply_patch", "edit_file", "read_file", "exec_command"]],
  [{ tools: { edit_file: { name: "update_file" }, read_file: { name: "look" }, exec_command: { name: "run" } } }, ["apply_patch", "update_file", "look", "run"]],
] as const)("registers the defaults for tools without overrides", async (options, names) => {
  const plugin = new WorkspacePlugin(root, options);
  if (options === undefined) {
    expect(plugin.id).toBe("workspace");
    expect(plugin.configurationId).toBe(JSON.stringify({
      root: resolve(root),
      tools: ["apply_patch", "edit_file"],
    }));
  }
  const harness = await AgentHarness.create({
    plugins: [plugin],
    modelScripts: [{ text: "done" }],
  });
  try {
    await harness.agent.generate("List workspace tools");
    expect(harness.provider.calls[0]?.tools.map(({ name }) => name)).toEqual(names);
  } finally {
    await harness.dispose();
  }
});

it("registers only apply_patch through the plugin host and executes one multi-file patch", async () => {
  await writeFile(join(root, "order.ts"), "const status = 'mới';\n");
  const source = patch(
    "*** Update File: order.ts", "@@", "-const status = 'mới';", "+const status = 'đã trả';",
    "*** Add File: test/order.test.ts", "+// Order tests",
  );
  const response = MessageCodec.encode(new AssistantMessage([
    { type: "tool-call", toolCallId: "patch-order", name: "apply_patch", arguments: { patch: source } },
  ]));
  const harness = await AgentHarness.create({
    plugins: [new WorkspacePlugin(root, { tools: { edit_file: false, read_file: false, exec_command: false } })],
    modelScripts: [{ response: { message: response } }, { text: "done" }],
  });
  try {
    const result = await harness.agent.generate("Update the order and create a test file");
    expect(result.status).toBe("completed");
    expect(harness.provider.calls[0]?.tools.map((tool) => tool.name)).toEqual(["apply_patch"]);
    expect(result.output.find((message) => message.role === "tool")?.content).toEqual([
      { type: "data", data: { paths: ["order.ts", "test/order.test.ts"] } },
    ]);
    expect(await readFile(join(root, "order.ts"), "utf8")).toBe("const status = 'đã trả';\n");
    expect(await readFile(join(root, "test/order.test.ts"), "utf8")).toBe("// Order tests\n");
  } finally {
    await harness.dispose();
  }
});

it("checks every hunk before publishing changes", async () => {
  await writeFile(join(root, "order.ts"), "status\nstatus\n");
  const write = createApplyPatch({ root });
  for (const line of ["status", "missing"]) {
    const source = patch(
      "*** Add File: new/test.ts", "+new test",
      "*** Update File: order.ts", "@@", `-${line}`, "+paid",
    );
    await expect(write.execute({ patch: source }, context)).rejects.toBeInstanceOf(TessarWorkspaceError);
    await expect(readFile(join(root, "new/test.ts"))).rejects.toHaveProperty("code", "ENOENT");
    expect(await readFile(join(root, "order.ts"), "utf8")).toBe("status\nstatus\n");
  }
});

it("uses context across hunks and preserves BOM and original line endings", async () => {
  const target = join(root, "order.ts");
  await writeFile(target, "\uFEFFfirst\r\nstatus\r\nsecond\nstatus");
  await createApplyPatch({ root }).execute({ patch: patch(
    "*** Update File: order.ts", "@@", " first", "-status", "+paid",
    "@@", " second", "-status", "+shipped",
  ) }, context);
  expect(await readFile(target, "utf8")).toBe("\uFEFFfirst\r\npaid\r\nsecond\nshipped");
});

it("preserves the surviving line ending when the last line is removed", async () => {
  const target = join(root, "order.ts");
  await writeFile(target, "keep\r\nremove\n");
  await createApplyPatch({ root }).execute({ patch: patch("*** Update File: order.ts", "@@", "-remove") }, context);
  expect(await readFile(target, "utf8")).toBe("keep\r\n");
});

it("rejects unsafe paths and exclusive creation over an existing file", async () => {
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(root, "exists.ts"), "original");
  await symlink(outside, join(root, "link"), "junction");
  const write = createApplyPatch({ root });
  for (const path of ["exists.ts", "../outside/test.ts", join(outside, "test.ts"), "link/test.ts"]) {
    await expect(write.execute({ patch: patch(`*** Add File: ${path}`, "+bad") }, context))
      .rejects.toBeInstanceOf(TessarWorkspaceError);
  }
  await expect(readFile(join(outside, "test.ts"))).rejects.toHaveProperty("code", "ENOENT");
  expect(await readFile(join(root, "exists.ts"), "utf8")).toBe("original");
});

it.skipIf(process.platform !== "win32")("checks Windows filenames before writing any file", async () => {
  const target = join(root, "order.ts");
  await writeFile(target, "before\n");
  const write = createApplyPatch({ root });
  for (const path of ["bad*file.ts", "CON.txt", "NUL"]) {
    await expect(write.execute({ patch: patch(
      "*** Update File: order.ts", "@@", "-before", "+after",
      `*** Add File: ${path}`, "+bad",
    ) }, context)).rejects.toBeInstanceOf(TessarWorkspaceError);
    expect(await readFile(target, "utf8")).toBe("before\n");
  }
});

it("serializes parallel edits through the same tool and respects cancellation", async () => {
  const target = join(root, "order.ts");
  await writeFile(target, "paid: 0\nshipped: 0\n");
  const write = createApplyPatch({ root });
  const edit = (name: string) => ({ patch: patch("*** Update File: order.ts", "@@", `-${name}: 0`, `+${name}: 1`) });
  await expect(write.execute(edit("paid"), { ...context, signal: AbortSignal.abort() }))
    .rejects.toHaveProperty("name", "AbortError");
  await Promise.all([write.execute(edit("paid"), context), write.execute(edit("shipped"), context)]);
  expect(await readFile(target, "utf8")).toBe("paid: 1\nshipped: 1\n");
});
