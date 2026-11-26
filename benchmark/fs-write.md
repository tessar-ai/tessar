# Filesystem tool benchmark

The benchmark calls `Tool.execute` for `apply_patch` and `edit_file` on the
original TypeScript implementation and on the Rust-backed `@tessar/workspace` package.
The TypeScript reference lives in `benchmark/fs-typescript/`. Each pair receives
the same input and workspace layout. Timing includes parsing or replacement
matching, workspace checks, atomic file publication, the Node-API call and
result handling. The runner prepares fixture files before timing and compares
the resulting bytes afterward. Addon loading and model time are outside the
timed interval.

```powershell
pnpm --filter @tessar/workspace... build
pnpm exec tsc -p benchmark/fs-typescript/tsconfig.json
node benchmark/fs-write.mjs --parity-only
node benchmark/fs-write.mjs
```

The runner compares tool results, file bytes and validation messages across
30 cases on Windows. There are 12 cases for `apply_patch` and 18 for `edit_file`,
including BOM and mixed line endings, Unicode, overlapping edits, invalid
text and paths outside the workspace. Each timed run alternates implementation
order and records 120 samples per implementation and workload after 15 warmups.

## Windows x64 results

Node v24.22.2, Rust 1.100.0 in release mode and Intel Core i7-12650H. Each table
entry is the median of that statistic across three runs. Times are in milliseconds.

| Workload | TS p50 | Rust p50 | TS p95 | Rust p95 | p50 reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| `apply_patch` creates a 4 KiB file | 0.86 | 0.57 | 1.32 | 0.80 | 33% |
| `apply_patch` edits one line in a 29 KiB file | 1.32 | 0.87 | 1.92 | 1.14 | 34% |
| `apply_patch` edits one line each in three 29 KiB files | 3.43 | 2.10 | 4.44 | 2.68 | 39% |
| `edit_file` makes one replacement in a 4 KiB file | 1.03 | 0.68 | 1.53 | 0.94 | 33% |
| `edit_file` makes one replacement in the same 29 KiB file | 1.04 | 0.74 | 1.49 | 1.02 | 29% |
| `edit_file` makes three replacements in a 600 KiB file with LF/CRLF | 4.06 | 2.35 | 8.66 | 2.97 | 42% |

On the 29 KiB file, the p50 saving is 0.45 ms for `apply_patch` and 0.30 ms for
`edit_file`. The larger `edit_file` case saves 1.71 ms at p50 and 5.69 ms at p95.
Both Rust tools submit the complete operation as one worker job and borrow
text slices where possible. The timings capture the combined effect of the
language, allocation and I/O scheduling.

The addon lives in `plugins/workspace/native/`. The benchmark compares tool results,
file bytes and validation error codes through the actual package exports.
Package tests exercise standalone Agent registration and edit recovery. A Rust
unit test verifies cancellation after staging and before atomic publication.
The measured and locally verified target is Windows x64.
