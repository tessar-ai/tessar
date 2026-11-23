import assert from "node:assert/strict";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Agent, Controller } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";

const WARMUPS = 2;
const SAMPLES = 7;
const FILE_ENTRIES = 1_000;
const PARALLEL_WRITES = 32;
const AGENT_TASKS = 12;
const TIMESTAMP = "2026-11-23T00:00:00.000Z";
const [first, second, third, fourth] = process.argv.slice(2);
const compare = first === "--compare";
const reportPath = compare ? fourth : second;
const builds = await Promise.all((compare ? [second, third] : [first]).map(async entry => ({
  entry: entry ?? "@tessar/logger",
  logger: await import(entry ? pathToFileURL(resolve(entry)).href : "@tessar/logger"),
  cases: [],
})));
const entries = Array.from({ length: FILE_ENTRIES }, (_, index) => ({
  type: "tool.end",
  level: "info",
  timestamp: TIMESTAMP,
  payload: { index, result: "x".repeat(256) },
}));

async function sample(name, { LoggerPlugin, FileTransport }) {
  const directory = await mkdtemp(join(tmpdir(), "tessar-logger-bench-"));
  const path = join(directory, "events.jsonl");
  const transport = new FileTransport({ path });
  let rows, elapsedMs, disposeMs;
  try {
    if (name === "agent") {
      const model = new ScriptedProvider(Array.from({ length: AGENT_TASKS }, () => ({ text: "Fixed answer" })));
      const agent = new Agent({ id: "bench-agent", model });
      const controller = new Controller({
        id: "bench-controller", agent,
        plugins: [new LoggerPlugin({ level: "debug", transports: [transport] })],
      });
      const started = performance.now();
      try {
        await controller.initialize();
        for (let i = 0; i < AGENT_TASKS; i++)
          assert.equal((await agent.generate("Run the fixed task")).status, "completed");
      } finally {
        const disposing = performance.now();
        await controller.dispose();
        disposeMs = performance.now() - disposing;
      }
      elapsedMs = performance.now() - started;
    } else {
      const width = name === "file-concurrent" ? PARALLEL_WRITES : 1;
      const started = performance.now();
      for (let offset = 0; offset < entries.length; offset += width)
        await Promise.all(entries.slice(offset, offset + width).map(entry => transport.write(entry)));
      const disposing = performance.now();
      await transport.close();
      disposeMs = performance.now() - disposing;
      elapsedMs = performance.now() - started;
    }
    rows = (await readFile(path, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    if (name === "agent")
      assert.equal(rows.filter(row => row.type === "stream.end").length, AGENT_TASKS);
    else assert.deepEqual(rows, entries);
    return { elapsedMs, disposeMs, rows: rows.length };
  } finally {
    await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
}

const median = numbers => numbers.toSorted((a, b) => a - b)[Math.floor(numbers.length / 2)];
for (const name of ["file-sequential", "file-concurrent", "agent"]) {
  const runs = builds.map(build => ({ build, samples: [] }));
  for (let i = 0; i < WARMUPS + SAMPLES; i++) {
    for (const run of i % 2 === 0 ? runs : runs.toReversed()) {
      const result = await sample(name, run.build.logger);
      if (i >= WARMUPS) run.samples.push(result);
    }
  }
  assert.equal(new Set(runs.flatMap(run => run.samples.map(result => result.rows))).size, 1);
  for (const { build, samples } of runs) {
    build.cases.push({
      name,
      rows: samples[0].rows,
      medianMs: median(samples.map(result => result.elapsedMs)),
      medianDisposeMs: median(samples.map(result => result.disposeMs)),
      samplesMs: samples.map(result => result.elapsedMs),
    });
  }
}
const report = JSON.stringify({
  node: process.version, os: process.platform, arch: process.arch,
  builds: builds.map(({ entry, cases }) => ({ entry, cases })),
}, null, 2);
if (reportPath) await writeFile(reportPath, report + "\n");
console.log(report);
