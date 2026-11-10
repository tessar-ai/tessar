import { createTestDatabase } from "../../plugins/database/libsql/test/database-fixture.js";
import { removeSqliteTestDirectory as rm } from "../helpers/sqlite-cleanup.js";
import { z } from "zod";
import { expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentHarness } from "@tessar/core/testing";
import { createTool } from "@tessar/core";
import { createLibsqlBackend } from "@tessar/libsql";
import { appendFileSync } from "node:fs";
const supportsSpawn = !spawnSync(process.execPath, ["--version"]).error;
it.skipIf(!supportsSpawn)(
  "fences two real processes racing with the same logical controller ID",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "tessar-process-")),
      filename = join(directory, "state.db");
    const run = (participant: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["tests/fixtures/sqlite-worker.ts", filename, participant],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(Error(stderr)),
        );
      });
    try {
      await Promise.all([run("a"), run("b")]);
      const results = await Promise.all(
        ["a", "b"].map(async (id) =>
          JSON.parse(await readFile(filename + "." + id + ".result", "utf8")),
        ),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok).code).toBe("OwnerActive");
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
);
it.skipIf(!supportsSpawn).each(["crash-model-result", "crash-tool-dispatch"])(
  "recovers SQLite after an actual process exits at %s",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "tessar-crash-")),
      filename = join(directory, "state.db");
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["tests/fixtures/sqlite-worker.ts", filename, mode],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(Error(stderr)),
        );
      });
      const identity = JSON.parse(
        await readFile(filename + ".execution", "utf8"),
      );
      const db = new DatabaseSync(filename);
      db.prepare("UPDATE tessar_leases SET expires_at=0 WHERE thread_id=?").run(
        identity.threadId,
      );
      db.close();
      const harness = await AgentHarness.create({
        backend: await createLibsqlBackend({ database: createTestDatabase(filename) }),
        plugins: [
          {
            id: "tools",
            setup(tessar) {
              tessar.tools.register(
                createTool({
                  name: "write",
                  description: "write",
                  schema: z.object({}),
                  execute: async () => {
                    appendFileSync(filename + ".effects", "write\n");
                    return "done";
                  },
                }),
              );
            },
          },
        ],
        modelScripts: [{ text: "finished" }],
      });
      try {
        const recovery = harness.collect(
          harness.admit({ kind: "recover", ...identity }),
        );
        if (mode === "crash-tool-dispatch") {
          await expect(recovery).rejects.toMatchObject({
            code: "RecoveryRequired",
          });
          expect((await harness.records(identity.streamId)).stream.status).toBe(
            "interrupted",
          );
        } else {
          await recovery;
          expect((await harness.records(identity.streamId)).stream.status).toBe(
            "completed",
          );
          expect(harness.provider.calls).toHaveLength(1);
        }
        expect(
          (await readFile(filename + ".effects", "utf8")).trim().split("\n"),
        ).toHaveLength(1);
      } finally {
        await harness.dispose();
      }
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
);
