# Tessar benchmarks

Use [agent-loop.mjs](agent-loop.mjs) as the Tessar baseline for framework
comparisons. It uses the real Agent, Controller, checkpoints and stream iterator
with a deterministic local model and tool. Start with `tools-short`,
`tools-history` and `stream-history` for execution and streaming overhead.

For each framework, use the same scripted responses, tool implementation,
history, output and streaming boundaries. Keep storage and observation settings
equivalent for the workloads being compared. Verify model calls, tool calls and
final output before comparing elapsed time or CPU measurements. Record platform,
runtime and framework versions alongside each run.

The fixed in-memory provider has no network, timers, request cloning or variable
model decisions. These workloads measure runtime overhead with synthetic inputs.

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

## Other benchmarks

| Area | Run or report |
| --- | --- |
| Session and Thread lifecycle, storage calls and capability registration | `node --expose-gc benchmark/core-lifecycle.mjs` · [report](core-lifecycle.md) |
| Filesystem read, including full 2,000-line and 50 KiB pages | [setup and results](fs-read.md) |
| Filesystem writes and TypeScript/Rust parity | [setup and results](fs-write.md) |
| Workspace command execution and output tail | [setup and results](workspace-exec.md) |
| Logger file writes and agent logging | `node benchmark/logger.mjs` · [report](logger.md) |
| Self-hosted JSON requests, SSE task completion and viewer RSS | `node benchmark/server-self-host.mjs fastify` |

The server benchmark starts the built CLI and exercises the server with
`TessarClient`. The historical self-host migration comparison used Windows,
Node 24.22.2, eight JSON workers, 60 tasks and 32 concurrent SSE viewers.

| Historical metric | Hono | Fastify |
| --- | ---: | ---: |
| JSON requests per second | 4,205 | 4,587 |
| JSON latency p95 | 3.98 ms | 3.64 ms |
| First SSE event p95 | 2.52 ms | 2.62 ms |
| Task completion p95 | 15.67 ms | 13.26 ms |
| Process RSS with 32 SSE viewers | 151.7 MiB | 157.3 MiB |

Earlier Core measurements are recorded in [execution analysis](analysis.md),
[checkpoint analysis](commit-pipeline.md) and [memory lifecycle](memory-lifecycle.md).

## PostgreSQL execution comparison

Set `TESSAR_BENCH_POSTGRES_URL` to a developer-provided test connection string;
the benchmark creates a fresh `tessar_bench_<uuid>` schema per run and **keeps
those schemas and data**. The pool closes even when setup fails. It does not
install extensions, drop schemas or change server settings.

```powershell
$env:TESSAR_BENCH_POSTGRES_URL = $env:TESSAR_TEST_POSTGRES_URL
$env:TESSAR_BENCH_CASES = "tools-history,session-tools-history,stream-history"
$env:TESSAR_BENCH_CORE = "benchmark/results/commit-before-core/dist/index.js"
node --expose-gc benchmark/agent-loop.mjs | Set-Content -Encoding utf8 benchmark/results/postgresql-before-loop.json
Remove-Item Env:\TESSAR_BENCH_CORE
node --expose-gc benchmark/agent-loop.mjs | Set-Content -Encoding utf8 benchmark/results/postgresql-after-loop.json
```

When a baseline build is selected, the runner also resolves every adapter's
`@tessar/core` import to that same build. This prevents comparing a baseline
Agent against storage validation helpers from a newer core. With no PostgreSQL
URL the runner continues using memory storage. `TESSAR_BENCH_CASES` optionally
selects comma-separated existing workloads; otherwise all seven run.
