import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AssistantMessage, MessageCodec, tool, ToolDecision } from "@tessar/core";
import { AgentHarness } from "@tessar/core/testing";
import type { ToolExecutionContext } from "@tessar/core/tool";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createExecCommand, TessarWorkspaceError, WorkspacePlugin } from "../src/index.js";

const temporaryRoot = resolve(tmpdir());
const context = { signal: AbortSignal.any([]) } as ToolExecutionContext;
const node = `"${process.execPath}"`;
const input = { command: `${node} command.mjs`, reason: "Run the project fixture" };
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(temporaryRoot, "tessar-workspace-exec-"));
});

afterEach(async () => {
  expect(resolve(root, "..")).toBe(temporaryRoot);
  await rm(root, { recursive: true, force: true });
});

it("runs from the project root and returns stdout, stderr and a nonzero exit code", async () => {
  await writeFile(join(root, "command.mjs"), `
    process.stdout.write(process.cwd());
    process.stderr.write("failed");
    process.exitCode = 7;
  `);
  const result = await createExecCommand({ root }).execute(input, context);
  expect(result.content).toEqual([
    { type: "data", data: { stdout: await realpath(root), stderr: "failed", exitCode: 7, truncated: false } },
  ]);
});

it("passes quoted arguments and pipelines through the platform shell", async () => {
  await writeFile(join(root, "command.mjs"), "process.stdout.write(process.argv[2]);");
  await writeFile(join(root, "consume.mjs"), "process.stdin.pipe(process.stdout);");
  const command = `${node} command.mjs "quoted argument" | ${node} consume.mjs`;
  const result = await createExecCommand({ root }).execute({ ...input, command }, context);
  expect(result.content).toEqual([
    { type: "data", data: { stdout: "quoted argument", stderr: "", exitCode: 0, truncated: false } },
  ]);
});

it("drains large output and keeps the tail of a line that exceeds the byte budget", async () => {
  await writeFile(join(root, "command.mjs"), 'process.stdout.write("0123456789".repeat(20_000));');
  const exec = createExecCommand({ root, maxOutputBytes: 5 });
  const result = await exec.execute(input, context);
  expect(result.content).toEqual([
    { type: "data", data: { stdout: "56789", stderr: "", exitCode: 0, truncated: true } },
  ]);
});

it("keeps the last complete lines when the shared byte budget cuts an older line", async () => {
  await writeFile(join(root, "command.mjs"), `
    process.stdout.write("old line\\nready\\n");
    setTimeout(() => process.stderr.write("fatal\\n"), 100);
  `);
  const result = await createExecCommand({ root, maxOutputBytes: 14 }).execute(input, context);
  expect(result.content).toEqual([
    { type: "data", data: { stdout: "ready\n", stderr: "fatal\n", exitCode: 0, truncated: true } },
  ]);
});

it("retains at most 2,000 lines even below the byte limit", async () => {
  await writeFile(join(root, "command.mjs"), 'process.stdout.write("old\\n" + "x\\n".repeat(1_999) + "last");');
  const result = await createExecCommand({ root }).execute(input, context);
  expect(result.content).toEqual([
    { type: "data", data: { stdout: "x\n".repeat(1_999) + "last", stderr: "", exitCode: 0, truncated: true } },
  ]);
});

it("keeps at most 50 KiB of output by default", async () => {
  await writeFile(join(root, "command.mjs"), 'process.stdout.write("x".repeat(60 * 1024));');
  const result = await createExecCommand({ root }).execute(input, context);
  expect(result.content).toEqual([
    { type: "data", data: { stdout: "x".repeat(50 * 1024), stderr: "", exitCode: 0, truncated: true } },
  ]);
});

it("rejects a command that exceeds the timeout", async () => {
  await writeFile(join(root, "command.mjs"), "setTimeout(() => {}, 2_000);");
  const exec = createExecCommand({ root, timeoutMs: 200 });
  await expect(exec.execute(input, context))
    .rejects.toMatchObject({ code: "CommandTimeout", source: "tool" });
});

it("stops the running command and its child when aborted", async () => {
  await writeFile(join(root, "child.mjs"), `
    import { writeFileSync } from "node:fs";
    writeFileSync("ready", "");
    setTimeout(() => writeFileSync("late", ""), 900);
  `);
  await writeFile(join(root, "command.mjs"), `
    import { spawn } from "node:child_process";
    spawn(process.execPath, ["child.mjs"], { stdio: "inherit" });
  `);
  const stop = new AbortController();
  const reason = new Error("Stop command");
  const result = createExecCommand({ root }).execute(input, { ...context, signal: stop.signal });
  const aborted = expect(result).rejects.toBe(reason);
  try {
    await expect.poll(() => stat(join(root, "ready")).then(() => true, () => false)).toBe(true);
  } finally {
    stop.abort(reason);
  }
  await aborted;
  await delay(900);
  await expect(stat(join(root, "late"))).rejects.toHaveProperty("code", "ENOENT");
});

it("rejects an invalid command or timeout configuration", async () => {
  expect(() => createExecCommand({ root, timeoutMs: 0 })).toThrow(TessarWorkspaceError);
  const exec = createExecCommand({ root });
  expect(exec.schema.safeParse({ command: input.command }).success).toBe(false);
  await expect(exec.execute({ ...input, command: "  " }, context))
    .rejects.toHaveProperty("code", "InvalidCommand");
  await expect(exec.execute({ ...input, reason: "  " }, context))
    .rejects.toHaveProperty("code", "InvalidCommand");
});

it("exposes the model's reason to the policy hook before execution", async () => {
  await writeFile(join(root, "command.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("ran", "");');
  const harness = await AgentHarness.create({
    plugins: [new WorkspacePlugin(root), {
      id: "command-policy",
      setup(tessar) {
        tessar.hook(tool.before, ({ payload }) => {
          expect(payload.arguments).toEqual(input);
          return ToolDecision.deny("Command declined");
        });
      },
    }],
    modelScripts: [{ response: { message: MessageCodec.encode(new AssistantMessage([
      { type: "tool-call", toolCallId: "run", name: "exec_command", arguments: input },
    ])) } }, { text: "done" }],
  });
  try {
    const result = await harness.agent.generate("Run the project fixture");
    expect(result.output.find(({ role }) => role === "tool")?.content)
      .toEqual([{ type: "text", text: "Command declined" }]);
    await expect(stat(join(root, "ran"))).rejects.toHaveProperty("code", "ENOENT");
  } finally {
    await harness.dispose();
  }
});
