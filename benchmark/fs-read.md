# Filesystem read benchmark

The runner compares the Rust-backed `createReadFile()` with a TypeScript
reference that reads the same files with Node's filesystem API. Both use
8 KiB reads, one-based line ranges, a cap of 2,000 lines or 50 KiB per page
and the same output shape. Timing covers `Tool.execute()`, workspace validation, file I/O,
line scanning, decoding and the Node-API call. Fixture creation and model
execution are outside the timed interval.

```powershell
pnpm --filter @tessar/workspace... build
pnpm exec tsc -p benchmark/fs-typescript/tsconfig.json
node benchmark/fs-read.mjs
```

## Windows x64 results

Node v24.22.2 on an Intel Core i7-12650H. Each workload alternates
implementation order and checks both results on every call. The table reports
the median of each statistic across three runs of 120 samples per
implementation and workload, after 15 warmups per run. Times are in milliseconds.

| Workload | TS p50 | Rust p50 | TS p95 | Rust p95 | p50 reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Read the whole 4 KiB file | 0.59 | 0.32 | 0.89 | 0.46 | 46% |
| Read the first 2,000 lines of a 1.5 MiB file | 0.83 | 0.39 | 1.29 | 0.61 | 53% |
| Read the default page of a 4 MiB file (800 lines, 50 KiB) | 0.61 | 0.31 | 1.02 | 0.55 | 49% |
| Read 2,000 lines starting at line 63,001 of the 1.5 MiB file | 5.98 | 1.29 | 6.60 | 1.54 | 78% |

The 1.5 MiB file uses 24 bytes per line, including CRLF, so a full 2,000-line
page fits in 48,000 bytes. The 4 MiB file uses 64 bytes per line and reaches
the byte cap after 800 lines.

The final case scans from the start of the file to locate the requested line.
The Rust implementation performs that scan within one native worker job.
The TypeScript reference awaits each chunk through Node's asynchronous
filesystem interface. These timings measure the effect of the full
implementations on files reused across samples.
