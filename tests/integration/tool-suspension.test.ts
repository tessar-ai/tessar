import { removeSqliteTestDirectory as rm } from "../helpers/sqlite-cleanup.js";
import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const execute = promisify(execFile);
async function run(command: string, filename: string) {
  return execute(
    process.execPath,
    ["tests/fixtures/tool-suspension-worker.ts", command, filename],
    { timeout: 15000, windowsHide: true },
  );
}
function expireLease(filename: string) {
  const db = new DatabaseSync(filename);
  try {
    db.exec("UPDATE tessar_leases SET expires_at=0");
  } finally {
    db.close();
  }
}

it.each(["start", "crash-wait", "crash-answer"])(
  "restores a tool suspension across processes at %s without replay",
  async (boundary) => {
    const directory = await mkdtemp(join(tmpdir(), "tessar-tool-wait-"));
    const filename = join(directory, "state.db");
    try {
      await run(boundary === "crash-wait" ? boundary : "start", filename);
      expect(await readFile(filename + ".calls", "utf8")).toBe("execute\n");
      if (boundary === "crash-wait") {
        expireLease(filename);
        expect(JSON.parse((await run("recover", filename)).stdout).status).toBe(
          "suspended",
        );
        expect(await readFile(filename + ".calls", "utf8")).toBe("execute\n");
      }
      if (boundary === "crash-answer") {
        await run(boundary, filename);
        expect(await readFile(filename + ".calls", "utf8")).toBe("execute\n");
        expireLease(filename);
      }
      const result = JSON.parse(
        (
          await run(
            boundary === "crash-answer" ? "recover" : "resume",
            filename,
          )
        ).stdout,
      );
      expect(result.status).toBe("completed");
      expect(result.output.find((m: any) => m.role === "tool")).toMatchObject({
        toolCallId: "call",
        content: [{ type: "text", text: "selected" }],
      });
      expect(await readFile(filename + ".calls", "utf8")).toBe(
        "execute\nresume\n",
      );
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
  30000,
);
