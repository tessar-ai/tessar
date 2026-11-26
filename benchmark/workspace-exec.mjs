import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WARMUPS = 7;
const SAMPLES = 40;
const CHUNK_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024;
const LARGE_LINES = 65_536;
const entry = process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : import.meta.resolve("@tessar/workspace");
const candidateEntry = process.argv[3] ? pathToFileURL(resolve(process.argv[3])).href : undefined;
const { createExecCommand } = await import(entry);
const windows = process.platform === "win32";
const root = await mkdtemp(join(tmpdir(), "tessar-workspace-exec-bench-"));
const fixture = join(root, "command.cjs");
const prefix = `"${process.execPath}" command.cjs`;
const line = "x".repeat(63) + "\n";
const last = "done".padEnd(63, "x") + "\n";
const reason = "Measure Workspace command execution";
const signal = new AbortController().signal;
const tool = createExecCommand({ root });
const candidate = candidateEntry ? (await import(candidateEntry)).createExecCommand({ root }) : undefined;
const cases = [
  { name: "shell-only", command: "exit 0", stdout: "", written: 0, truncated: false },
  { name: "child-small", command: `${prefix} small`, stdout: "ok\n", written: 3, truncated: false },
  { name: "child-2200-lines", command: `${prefix} lines`, stdout: "x\n".repeat(1_999) + "done\n", written: 4_403, truncated: true },
  { name: "child-4MiB", command: `${prefix} bytes`, stdout: line.repeat(799) + last, written: 4 * 1024 * 1024, truncated: true },
];

function drain(command) {
  const child = spawn(command, { cwd: root, shell: true, detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", chunk => { stdoutBytes += chunk.length; });
    child.stderr.on("data", chunk => { stderrBytes += chunk.length; });
    child.once("error", reject);
    child.once("close", exitCode => resolve({ stdoutBytes, stderrBytes, exitCode }));
  });
}

function summary(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  const at = p => sorted[Math.ceil(sorted.length * p) - 1];
  return { p50Ms: at(0.50), p95Ms: at(0.95), samples };
}

try {
  await writeFile(fixture, `
    const mode = process.argv[2];
    if (mode === "small") process.stdout.write("ok\\n");
    if (mode === "lines") process.stdout.write("x\\n".repeat(2_199) + "done\\n");
    if (mode === "bytes") process.stdout.write(${JSON.stringify(line)}.repeat(${LARGE_LINES - 1}) + ${JSON.stringify(last)});
  `);
  const measurements = [];
  for (const { name, command, stdout, written, truncated } of cases) {
    const checkTool = result => {
      assert.deepEqual(result.content, [{ type: "data", data: { stdout, stderr: "", exitCode: 0, truncated } }]);
    };
    const runs = [["tool", () => tool.execute({ command, reason }, { signal }), checkTool]];
    if (candidate) runs.push(["candidate", () => candidate.execute({ command, reason }, { signal }), checkTool]);
    else runs.push(["drain", () => drain(command), result => {
      assert.deepEqual(result, { stdoutBytes: written, stderrBytes: 0, exitCode: 0 });
    }]);
    const samples = Object.fromEntries(runs.map(([name]) => [name, []]));
    for (let i = 0; i < WARMUPS + SAMPLES; i++) {
      for (const [name, run, check] of i % 2 ? runs.toReversed() : runs) {
        const started = performance.now();
        const result = await run();
        const elapsed = performance.now() - started;
        check(result);
        if (i >= WARMUPS) samples[name].push(elapsed);
      }
    }
    const timings = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, summary(values)]));
    measurements.push({ name, written, returned: Buffer.byteLength(stdout), ...timings });
  }

  const outputModule = new URL("./command-output.js", entry);
  let tail;
  try {
    const { CommandOutput } = await import(outputModule.href);
    const payload = Buffer.from(line.repeat(LARGE_LINES - 1) + last);
    const chunks = Array.from({ length: payload.length / CHUNK_BYTES }, (_, i) => payload.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
    const samples = [];
    for (let i = 0; i < WARMUPS + SAMPLES; i++) {
      const started = performance.now();
      const output = new CommandOutput(MAX_OUTPUT_BYTES);
      for (const chunk of chunks) output.add("stdout", chunk);
      const result = output.finish();
      const elapsed = performance.now() - started;
      assert.deepEqual(result, { stdout: cases.at(-1).stdout, stderr: "", truncated: true });
      if (i >= WARMUPS) samples.push(elapsed);
    }
    tail = { bytes: payload.length, chunkBytes: CHUNK_BYTES, ...summary(samples) };
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== outputModule.href) throw error;
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
    entry: fileURLToPath(entry), candidate: candidateEntry && fileURLToPath(candidateEntry),
    warmups: WARMUPS, samples: SAMPLES, measurements, tail }, null, 2));
} finally {
  assert.equal(dirname(root), resolve(tmpdir()));
  await unlink(fixture);
  await rmdir(root);
}
