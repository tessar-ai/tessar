import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const entry = resolve("tests/fixtures/apps/server/dist/main.js");
const PROCESS_WAIT_TIMEOUT_MS = 10000;
function launch(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, ...env }, windowsHide: true, stdio: "pipe" });
  let stdout = "", stderr = "";
  child.stdout.on("data", value => { stdout += value; });
  child.stderr.on("data", value => { stderr += value; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { child, exited, output: () => ({ stdout, stderr }),
    async url() {
      await expect.poll(() => stdout.match(/http:\/\/[^\s]+/)?.[0], { timeout: PROCESS_WAIT_TIMEOUT_MS }).toBeTruthy();
      return stdout.match(/http:\/\/[^\s]+/)![0];
    },
    async stop() { child.stdin.end(); await exited; },
  };
}

test("public-package server persists Session/Thread/records across native libSQL restart without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tessar-server-"));
  let processHandle: ReturnType<typeof launch> | undefined;
  try {
    const env = { TESSAR_FIXTURE_DB: join(directory, "state.db") };
    processHandle = launch(env);
    let url = await processHandle.url();
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(url + path, { method, ...(body === undefined ? {} : {
        body: JSON.stringify(body), headers: { "content-type": "application/json" },
      }) });
      expect(response.ok, await (!response.ok ? response.text() : Promise.resolve(""))).toBe(true);
      return response.status === 204 ? null : response.json();
    };
    const c = "/api/controllers/fixture";
    const session = await request(c + "/sessions", "POST", {});
    const s = c + "/sessions/" + session.id;
    const thread = await request(s + "/threads", "POST", { title: "persisted" });
    await request(c + "/records/notes", "POST", { data: { saved: true } });
    const receipt = await request(s + "/follow-up", "POST", { input: "hello" });
    expect(receipt.threadId).toBe(thread.id);
    await expect.poll(async () => (await request(s + "/state")).status, { timeout: PROCESS_WAIT_TIMEOUT_MS }).toBe("completed");
    expect((await request("/calls")).count).toBe(1);
    await processHandle.stop();
    processHandle = launch(env); url = await processHandle.url();
    expect((await request(s)).selectedThreadId).toBe(thread.id);
    expect(JSON.stringify((await request(s + "/state")).messages)).toContain("server fixture answer");
    expect((await request(c + "/records/notes")).items[0].data).toEqual({ saved: true });
    expect((await request("/calls")).count).toBe(0);
    const response = await fetch(url + s + "/state/stream");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("server fixture answer");
    await reader.cancel();
    expect((await request("/calls")).count).toBe(0);
  } finally {
    await processHandle?.stop();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"))) throw Error("Unsafe cleanup");
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}, 30000);

test("startup errors retain diagnostics and return a nonzero exit", async () => {
  const occupied = createServer();
  await new Promise<void>(done => occupied.listen(0, "127.0.0.1", done));
  const address = occupied.address();
  if (!address || typeof address === "string") throw Error("No port");
  try {
    for (const [env, expected] of [
      [{ TESSAR_FIXTURE_PORT: String(address.port) }, "EADDRINUSE"],
      [{ TESSAR_FIXTURE_FAIL: "1" }, "fixture initialization failure"],
    ] as const) {
      const host = launch(env);
      try {
        await expect.poll(() => host.output().stderr, { timeout: PROCESS_WAIT_TIMEOUT_MS }).toContain(expected);
        await host.stop();
        expect(await host.exited).toBe(1);
        expect(host.output().stdout).not.toContain("listening");
      } finally { if (host.child.exitCode === null) { host.child.kill(); await host.exited; } }
    }
  } finally { await new Promise<void>(done => occupied.close(() => done())); }
}, 30000);

test("explicit HTTP resume after restart does not repeat a completed tool effect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tessar-server-resume-"));
  const env = { TESSAR_FIXTURE_DB: join(directory, "state.db"), TESSAR_FIXTURE_SUSPEND: "1", TESSAR_FIXTURE_EFFECT: join(directory, "effects.txt") };
  let host = launch(env);
  try {
    let url = await host.url();
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(url + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
      return { status: response.status, data: response.status === 204 ? null : await response.json() };
    };
    const { data: session } = await request("/api/controllers/fixture/sessions", "POST", {});
    const s = `/api/controllers/fixture/sessions/${session.id}`;
    await request(s + "/threads", "POST", {});
    expect((await request(s + "/follow-up", "POST", { input: "work" })).status).toBe(202);
    await expect.poll(async () => (await request(s + "/state")).data.status, { timeout: PROCESS_WAIT_TIMEOUT_MS }).toBe("suspended");
    const interrupt = (await request(s + "/state")).data.interrupt;
    expect(await readFile(env.TESSAR_FIXTURE_EFFECT, "utf8")).toBe("effect\n");
    await host.stop();
    host = launch({ ...env, TESSAR_FIXTURE_RESUMED: "1" }); url = await host.url();
    expect((await request(s + "/state")).data.status).toBe("suspended");
    expect((await request("/calls")).data.count).toBe(0);
    expect((await request(s + "/resume", "POST", { interruptId: interrupt.id, value: true })).status).toBe(202);
    await expect.poll(async () => (await request(s + "/state")).data.status, { timeout: PROCESS_WAIT_TIMEOUT_MS }).toBe("completed");
    expect((await request("/calls")).data.count).toBe(1);
    expect(await readFile(env.TESSAR_FIXTURE_EFFECT, "utf8")).toBe("effect\n");
  } finally {
    await host.stop();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"))) throw Error("Unsafe cleanup");
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}, 30000);
