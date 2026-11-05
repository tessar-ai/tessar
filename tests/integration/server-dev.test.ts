import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

async function project() {
  const root = await mkdtemp(join(tmpdir(), "tessar-dev-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules/@tessar"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  for (const name of ["core", "server"])
    await symlink(resolve("packages", name), join(root, "node_modules/@tessar", name), process.platform === "win32" ? "junction" : "dir");
  return root;
}
function launch(root: string) {
  const child = spawn(process.execPath, [resolve("packages/cli/dist/bin.js"), "dev"], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "", stderr = "";
  child.stdout!.on("data", value => { stdout += value; });
  child.stderr!.on("data", value => { stderr += value; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { child, exited, output: () => ({ stdout, stderr }),
    async stop() { if (child.connected) { child.send("shutdown"); child.disconnect(); } await exited; },
  };
}
async function remove(root: string) {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe test cleanup");
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

test("tessar dev loads src/index.ts, .env and .js source imports, and serves Agent-only APIs", async () => {
  const root = await project();
  await writeFile(join(root, ".env"), "TESSAR_DEV_AGENT=cli-assistant\n");
  await writeFile(join(root, "src/model.ts"), `
import { ScriptedProvider } from "@tessar/core/testing";
class Settings { constructor(public readonly answer: string) {} }
export const model = new ScriptedProvider([{ text: new Settings("CLI answer").answer }]);
`);
  await writeFile(join(root, "src/index.ts"), `
import { Agent } from "@tessar/core";
import { Tessar } from "@tessar/server";
import { model } from "./model.js";
export default new Tessar({ agents: [new Agent({ id: process.env.TESSAR_DEV_AGENT!, model })],
  server: { port: 0, prefix: "/t", openapiPath: "/schema.json" } });
`);
  const host = launch(root);
  try {
    await expect.poll(() => host.output().stdout.match(/http:\/\/[^\s]+/)?.[0], { timeout: 10000 }).toBeTruthy();
    const url = host.output().stdout.match(/http:\/\/[^\s]+/)![0];
    expect((await (await fetch(url + "/t/api/agents")).json())[0].id).toBe("cli-assistant");
    const result = await fetch(url + "/t/api/agents/cli-assistant/generate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "hi" }),
    });
    expect((await result.json()).status).toBe("completed");
    expect((await (await fetch(url + "/t/schema.json")).json()).openapi).toBe("3.1.0");
    await host.stop();
    expect(await host.exited).toBe(0);
  } finally { if (host.child.exitCode === null) await host.stop(); await remove(root); }
}, 20000);

test.each([false, true])("tessar dev rejects a missing or invalid default entry (file exists: %s)", async exists => {
  const root = await project();
  if (exists) await writeFile(join(root, "src/index.ts"), "export default {};\n");
  const host = launch(root);
  try {
    expect(await host.exited).toBe(1);
    expect(host.output().stderr).toContain(exists ? "default-export a Tessar instance" : "Expected src/index.ts");
    expect(host.output().stdout).not.toContain("listening");
  } finally { if (host.child.connected) host.child.disconnect(); await remove(root); }
});
