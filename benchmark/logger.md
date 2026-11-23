# Logger benchmark

Measured on Windows x64 with Node.js 24.22.2 using `benchmark/logger.mjs`.
The first run captured the TypeScript build before changing the logger. The
final comparison loaded that saved build and the Rust build in the same Node
process, alternating their order for each of seven measured samples after two
warmups. Times are medians and include disposal. The scripted model uses no
network. Both builds wrote the same number of records, and the file cases
verified the contents and order of every JSON line.

| Workload | Rows | TypeScript before port | TypeScript paired | Rust paired | Lower elapsed time |
| --- | ---: | ---: | ---: | ---: | ---: |
| File writes, sequential | 1,000 | 143.2 ms | 181.2 ms | 119.2 ms | 34% |
| File writes, up to 32 pending | 1,000 | 148.1 ms | 343.9 ms | 179.9 ms | 48% |
| Agent, 12 scripted tasks with debug logs | 145 | 96.9 ms | 173.6 ms | 149.6 ms | 14% |

The early Rust port used a separate asynchronous work item for each write and
was slower than the initial TypeScript run. The final Rust file transport uses
one native writer thread per active transport to process writes in order. The
paired result measures the combined language and scheduling changes. It is a
local latency comparison for the file transport and agent workload on Windows.

To reproduce the paired run, retain the built TypeScript logger's entry and
sibling modules before building Rust, then pass both entries to the benchmark:

```sh
node benchmark/logger.mjs --compare benchmark/results/logger-ts/index.js plugins/logger/dist/index.js benchmark/results/logger-comparison.json
```
