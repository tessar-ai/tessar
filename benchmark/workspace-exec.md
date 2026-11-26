# Workspace command baseline

The benchmark calls `createExecCommand()` through the public Workspace entry.
It checks the returned text, truncation and exit code after every sample. The
reference spawns the same shell command and drains the same pipes while counting
bytes. It provides a comparison for process startup and I/O without retaining
or formatting command output.

## Run

```powershell
pnpm --filter @tessar/workspace build
node benchmark/workspace-exec.mjs
```

Pass a built entry point as the first argument to run the same workload against
a saved build. The TypeScript build and raw samples for this run are under the
ignored `benchmark/results/exec-ts-baseline/` directory.

```powershell
node benchmark/workspace-exec.mjs benchmark/results/exec-ts-baseline/dist/index.js
```

## TypeScript results

Windows x64, Node 24.22.2, Intel Core i7-12650H. Three runs each used seven
warmups and 40 samples per variant and case, with alternating variant order.
The table reports the median of each per-run percentile in milliseconds.

| Workload | `exec_command` p50 | `exec_command` p95 | Spawn and drain p50 | Spawn and drain p95 |
| --- | ---: | ---: | ---: | ---: |
| Shell runs `exit 0` | 26.88 | 37.93 | 25.65 | 45.66 |
| Node child writes `ok` | 67.34 | 89.09 | 67.52 | 93.08 |
| Node child writes 2,200 short lines | 70.10 | 83.84 | 68.94 | 84.98 |
| Node child writes 4 MiB | 74.07 | 86.32 | 73.81 | 87.99 |

The 2,200-line case returns the last 2,000 lines. The 4 MiB case returns 800
64-byte lines for 50 KiB. The isolated TypeScript output accumulator processed
the same 4 MiB data in preallocated 64 KiB chunks at 0.20 ms p50 and 0.32 ms p95.
The accumulator measurement excludes subprocess startup and pipe I/O.

The end-to-end timings vary across runs, with overlapping tool and reference
latencies. They measure successful local execution with one command in flight.
Use the saved build to compare a later Rust implementation on the same machine
and with the same Core build and output assertions.

A separate Node CPU profile of the full benchmark sampled the parent process
for 24.37 seconds. It attributed 21.33 seconds to idle time and 2.38 seconds to
`spawn` frames, including both benchmark variants. Self time in the TypeScript
command runner and output accumulator totaled about 24 ms. The profile excludes
CPU work inside child processes and is available as `parent.cpuprofile` beside
the raw results.

## TypeScript and Rust comparison

The Workspace package uses the TypeScript implementation. The Rust trial build
is archived with the original samples for local comparison.

Pass both built entry points to alternate the original TypeScript implementation
and the Rust implementation in the same process. The runner checks the complete
tool result on every sample.

```powershell
node benchmark/workspace-exec.mjs benchmark/results/exec-ts-baseline/dist/index.js benchmark/results/exec-rust-trial-20261126-134323/dist/index.js
```

Windows x64, Node 24.22.2, Intel Core i7-12650H. The numbers below are the medians
of the three per-run percentiles, in milliseconds. Each run used seven warmups and
40 measured calls per implementation and workload.

| Workload | TypeScript p50 | Rust p50 | TypeScript p95 | Rust p95 |
| --- | ---: | ---: | ---: | ---: |
| Shell runs `exit 0` | 28.66 | 30.30 | 38.24 | 37.81 |
| Node child writes `ok` | 63.27 | 62.37 | 85.00 | 81.71 |
| Node child writes 2,200 short lines | 67.66 | 69.51 | 80.11 | 83.21 |
| Node child writes 4 MiB | 75.03 | 77.20 | 90.96 | 89.29 |

The differences in median latency ranged from a 0.89 ms improvement to a 2.17 ms
increase. The original profile attributes most parent-process time to waiting for
subprocesses and launching them. The Windows x64 addon grew from 555 KiB to
1,004 KiB. These measurements cover warmed, sequential calls on Windows. Raw
samples are in `benchmark/results/exec-rust-trial-20261126-134323/`.
