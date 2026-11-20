# Core performance benchmarks

Measure Tessar's TypeScript execution overhead before considering native code.
The fixed in-memory provider has no network, timers, request cloning or variable
model decisions. Every tool returns the same in-memory result. The benchmark
uses the real Agent, Controller, memory backend, checkpoints and stream iterator.

## Run

Build the workspace first, then run from the repository root:

```powershell
pnpm build
New-Item -ItemType Directory -Force benchmark/results | Out-Null
node --expose-gc benchmark/agent-loop.mjs | Set-Content -Encoding utf8 benchmark/results/before.json
```

Run the same command after an optimization, changing `before.json` to `after.json`.
Keep Node version, machine and workload unchanged. For CPU profiling, add
`--cpu-prof --cpu-prof-dir=benchmark/results` before the script path. Compare
timings without profiling; a profiler adds overhead. Results/profiles are ignored
by Git. The script exits unsuccessfully if the task fails or its model/tool/hook
counts or final answer change.

To compare a separately built baseline without editing the working tree, point
`TESSAR_BENCH_CORE` to that build's public `dist/index.js`:

```powershell
$env:TESSAR_BENCH_CORE = "C:\path\to\baseline\packages\core\dist\index.js"
try {
  node --expose-gc benchmark/agent-loop.mjs | Set-Content -Encoding utf8 benchmark/results/before.json
} finally {
  Remove-Item Env:TESSAR_BENCH_CORE
}
```

## Workloads

Each workload has two warmups and five measured samples. Setup, explicit GC and
disposal are outside the measured interval; execution, rendering snapshots and
checkpoint work are inside. Results include every sample, median elapsed time,
process CPU time, commits and snapshot counts.

| Case | Work |
| --- | --- |
| `tools-short` | 10 sequential tool calls and a final answer |
| `tools-history` | Same task with 100 prior messages, 1,024 characters each |
| `stream-short` | Final answer delivered as 128 deltas |
| `stream-history` | Same deltas with the 100-message history |
| `stream-plugins` | Same history and deltas with 20 notification handlers |
| `session-tools-history` | Same 10-tool task through Session follow-up and subscription |
| `session-stream-history` | Same long-history stream through Session observation |

The Session cases create/select their history before measurement, then measure
follow-up until execution and the input queue are idle. Agent cases measure the
stream through EOF. Compare each case only with its matching baseline. A full
CPU profile also includes setup, GC and teardown; use it to locate work, not to
attribute every sample to the timed interval.

## Optimization scope

1. Capture baseline timings and CPU profiles using the current implementation.
2. Optimize repeated validation/copying of immutable data where profiling shows
   it costs time. Preserve validation of caller-owned data, frozen snapshots,
   event order, tool scheduling and all checkpoint/recovery boundaries.
3. Add deterministic regression tests for removed repeated work and mutation
   isolation. Run package/process tests, then repeat the identical benchmark.
4. Record measured improvements and remaining hotspots here. Further changes to
   durability, scheduling or public APIs need a separate design.

These are local synthetic workloads, not a comparison with other frameworks.
They do not measure browser rendering, HTTP transport, external tools, model
latency, durable database I/O or maximum concurrent server throughput.

See [analysis.md](analysis.md) for the measured baseline, retained optimizations
and remaining work.

For lifecycle work outside the execution loop, run `node --expose-gc
benchmark/core-lifecycle.mjs` and see [core-lifecycle.md](core-lifecycle.md). This
inspects core storage-call counts and synthetic capability registration; it does
not benchmark built-in plugins or backend drivers.
