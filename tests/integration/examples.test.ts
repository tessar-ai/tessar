import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
function run(file: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [file, ...args], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
it("runs built offline headless and CLI consumers", () => {
  expect(run("tests/fixtures/apps/headless/dist/main.js")).toMatchObject({
    status: "completed",
    output: "fixture answer",
  });
  expect(run("tests/fixtures/apps/cli/dist/main.js", ["hello"])).toMatchObject({
    status: "completed",
    output: "fixture answer",
  });
});
it("resumes a CLI tool approval across process restart with the same logical stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tessar-cli-")),
    filename = join(directory, "state.db");
  try {
    const pending = run("tests/fixtures/apps/cli/dist/main.js", [
      "hello",
      "--db",
      filename,
      "--approval",
    ]);
    expect(pending.status).toBe("suspended");
    expect(pending.toolCalls).toBe(0);
    const result = run("tests/fixtures/apps/cli/dist/main.js", [
      "--db",
      filename,
      "--thread",
      pending.threadId,
      "--resume",
      pending.interruptId,
      "--approval",
    ]);
    expect(result).toMatchObject({
      status: "completed",
      streamId: pending.streamId,
      toolCalls: 1,
      output: "fixture answer",
    });
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
it("runs the source boundary check", () => {
  const result = spawnSync(process.execPath, ["scripts/check-boundaries.mjs"], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
});
