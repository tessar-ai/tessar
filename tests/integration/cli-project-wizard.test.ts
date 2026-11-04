import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cli = resolve("packages/cli/dist/bin.js");
const backends = ["memory", "libsql", "postgresql", "mongodb"] as const;
const configurations = [
  { controller: false, session: false, backend: "memory" },
  ...backends.flatMap(backend => [false, true].map(session => ({ controller: true, session, backend }))),
];

function run(file: string, args: string[], cwd: string, answers = "") {
  const result = execute(process.execPath, [file, ...args], { cwd, windowsHide: true, timeout: 30000 });
  result.child.stdin!.end(answers);
  return result;
}

async function linkSdk(project: string, backend: string) {
  const dependencies = ["@tessar/core", "@tessar/openai", "zod", "@types/node"];
  if (backend !== "memory") dependencies.push(`@tessar/${backend}`);
  if (backend === "libsql") dependencies.push("libsql");
  if (backend === "postgresql") dependencies.push("pg", "@types/pg");
  if (backend === "mongodb") dependencies.push("mongodb");
  for (const name of dependencies) {
    const source = name.startsWith("@tessar/") ? `packages/${name.slice(8)}` : `node_modules/${name}`;
    const target = join(project, "node_modules", name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(realpathSync(resolve(source)), target, process.platform === "win32" ? "junction" : "dir");
  }
}

it.each(configurations)("compiles and wires wizard selection $controller/$session/$backend", async ({ controller, session, backend }) => {
  const root = await mkdtemp(join(tmpdir(), "tessar wizard "));
  try {
    const answers = controller ? `yes\n${session ? "yes" : "no"}\n${backends.indexOf(backend as typeof backends[number]) + 1}\nyes\n` : "no\nyes\n";
    await run(cli, ["new", "sample-app"], root, answers);
    const project = join(root, "sample-app");
    expect(existsSync(join(project, "src/controllers/main.ts"))).toBe(controller);
    expect(existsSync(join(project, "src/sessions/chat.ts"))).toBe(session);
    expect(existsSync(join(project, "src/storage.ts"))).toBe(controller && backend !== "memory");
    const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    for (const optional of backends.filter(name => name !== "memory"))
      expect(Boolean(manifest.dependencies[`@tessar/${optional}`])).toBe(controller && backend === optional);
    await linkSdk(project, backend);
    await run(resolve("node_modules/typescript/bin/tsc"), ["--project", "tsconfig.json"], project);
    if (backend !== "memory" && backend !== "libsql") return;
    await writeFile(join(project, "main-smoke.mjs"), `
import assert from "node:assert/strict";
process.env.OPENAI_API_KEY = "local-test-key";
process.env.OPENAI_MODEL = "local-test-model";
process.env.LIBSQL_PATH = "./wizard.db";
let calls = 0;
globalThis.fetch = async (_url, options) => {
  calls++;
  const request = JSON.parse(options.body);
  assert.equal(request.model, "local-test-model");
  assert.equal(request.stream, true);
  if (process.argv.includes("--fail-model")) {
    const failure = { type: "response.failed", sequence_number: 0, response: {
      id: "failed-response", status: "failed", output: [], error: { code: "model_error", message: "wizard model failure" },
    } };
    return new Response("event: response.failed\\ndata: " + JSON.stringify(failure) + "\\n\\n", { headers: { "content-type": "text/event-stream" } });
  }
  const chunk = { type: "response.completed", sequence_number: 1, response: {
    id: "local-response", status: "completed", output: [{
      type: "message", id: "local-message", role: "assistant",
      content: [{ type: "output_text", text: "wizard answer", annotations: [] }],
    }],
  } };
  const delta = { type: "response.output_text.delta", sequence_number: 0, output_index: 0, content_index: 0, item_id: "local-message", delta: "wizard answer" };
  return new Response("event: response.output_text.delta\\ndata: " + JSON.stringify(delta) + "\\n\\nevent: response.completed\\ndata: " + JSON.stringify(chunk) + "\\n\\n", { headers: { "content-type": "text/event-stream" } });
};
await import("./dist/main.js");
assert.equal(calls, 1);
${backend === "libsql" ? `const { default: Database } = await import("libsql");
const db = new Database("wizard.db");
try {
  assert.ok(db.prepare("SELECT count(*) AS count FROM tessar_messages").get().count > 0);
} finally { db.close(); }` : ""}
`);
    expect((await run(join(project, "main-smoke.mjs"), [], project)).stdout).toContain("wizard answer");
    if (session) {
      await expect(run(join(project, "main-smoke.mjs"), ["--fail-model"], project)).rejects.toMatchObject({
        code: 1,
        killed: false,
        stderr: expect.stringContaining("wizard model failure"),
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60000);

it("leaves no project after EOF or declined confirmation and rejects an existing target before prompting", async () => {
  const root = await mkdtemp(join(tmpdir(), "tessar wizard cancellation "));
  try {
    for (const answers of ["", "yes\n", "yes\nyes\n", "yes\nyes\n1\n", "no\nno\n", "yes\nno\n2\nno\n"]) {
      await run(cli, ["new", "cancelled-app"], root, answers).catch(() => undefined);
      expect(existsSync(join(root, "cancelled-app"))).toBe(false);
    }
    const project = join(root, "existing-app");
    await mkdir(project);
    await writeFile(join(project, "keep.txt"), "original");
    await expect(run(cli, ["new", "existing-app"], root)).rejects.toMatchObject({
      stdout: expect.not.stringMatching(/Controller.*\?/i),
    });
    expect(await readFile(join(project, "keep.txt"), "utf8")).toBe("original");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60000);
