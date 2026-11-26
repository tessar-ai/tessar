import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, AssistantMessage, MessageCodec } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import type { ToolExecutionContext } from "@tessar/core/tool";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createReadFile } from "../src/index.js";

const temporaryRoot = resolve(tmpdir());
const context = { signal: new AbortController().signal } as ToolExecutionContext;
let directory: string;
let root: string;

beforeEach(async () => {
  directory = await mkdtemp(join(temporaryRoot, "tessar-read-file-"));
  root = join(directory, "workspace");
  await mkdir(root);
});

afterEach(async () => {
  expect(resolve(directory, "..")).toBe(temporaryRoot);
  await rm(directory, { recursive: true, force: true });
});

it("reads a line range through a standalone Agent and preserves UTF-8 and CRLF", async () => {
  await writeFile(join(root, "orders.ts"), "first\r\n\u0111\u00e3 tr\u1ea3 \u{1f642}\r\nlast");
  const model = new ScriptedProvider([
    { response: { message: MessageCodec.encode(new AssistantMessage([
      { type: "tool-call", toolCallId: "read", name: "look", arguments: { path: "orders.ts", startLine: 2, limit: 1 } },
    ])) } },
    { text: "done" },
  ]);
  const agent = new Agent({ id: "reader", model, tools: { look: createReadFile({ root }) } });
  try {
    const result = await agent.generate("Read the second line");
    expect(result.output.find(({ role }) => role === "tool")?.content).toEqual([
      { type: "data", data: { text: "\u0111\u00e3 tr\u1ea3 \u{1f642}\r\n", nextLine: 3 } },
    ]);
  } finally {
    await agent.shutdown();
  }
});

it("returns at most 2,000 lines per page and null at EOF", async () => {
  const text = "line\n".repeat(2_000);
  await writeFile(join(root, "log.txt"), text + "tail");
  const read = createReadFile({ root });
  expect((await read.execute({ path: "log.txt" }, context)).content).toEqual([
    { type: "data", data: { text, nextLine: 2_001 } },
  ]);
  expect((await read.execute({ path: "log.txt", limit: 3_000 }, context)).content).toEqual([
    { type: "data", data: { text, nextLine: 2_001 } },
  ]);
  expect((await read.execute({ path: "log.txt", startLine: 2_001 }, context)).content).toEqual([
    { type: "data", data: { text: "tail", nextLine: null } },
  ]);
});

it("returns only complete lines within 50 KiB and reports an oversized first line", async () => {
  const text = "a".repeat(45 * 1024 - 1) + "\n";
  const next = "b".repeat(6 * 1024 - 1) + "\n";
  const oversized = "c".repeat(50 * 1024) + "\n";
  await writeFile(join(root, "large.txt"), text + next + oversized + "end");
  const read = createReadFile({ root });
  expect((await read.execute({ path: "large.txt" }, context)).content).toEqual([
    { type: "data", data: { text, nextLine: 2 } },
  ]);
  expect((await read.execute({ path: "large.txt", startLine: 2 }, context)).content).toEqual([
    { type: "data", data: { text: next, nextLine: 3 } },
  ]);
  await expect(read.execute({ path: "large.txt", startLine: 3 }, context))
    .rejects.toMatchObject({ code: "InvalidRead", message: expect.stringContaining("Line 3") });
  expect((await read.execute({ path: "large.txt", startLine: 4 }, context)).content).toEqual([
    { type: "data", data: { text: "end", nextLine: null } },
  ]);
});

it("rejects binary data, paths outside the workspace and an aborted read", async () => {
  const read = createReadFile({ root });
  await writeFile(join(root, "bad.txt"), Buffer.from([0xff, 0xfe]));
  await writeFile(join(root, "scan.pdf"), "%PDF-1.4\ncontent");
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside");
  await symlink(outside, join(root, "outside"), "junction");
  for (const path of ["bad.txt", "scan.pdf"])
    await expect(read.execute({ path }, context)).rejects.toHaveProperty("code", "InvalidRead");
  for (const path of ["../secret.txt", "outside/secret.txt"])
    await expect(read.execute({ path }, context)).rejects.toHaveProperty("code", "InvalidPath");
  await expect(read.execute({ path: "bad.txt" }, { ...context, signal: AbortSignal.abort() }))
    .rejects.toHaveProperty("name", "AbortError");
});
