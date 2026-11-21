# Rust feasibility after TypeScript optimization

Scope: core computation, excluding model/network latency, built-in tools and
database-driver optimization. This is analysis and a proposed benchmark spike,
not a decision to add Rust to production packages.

## Fresh TypeScript baseline

Measured after the audit fixes on Windows x64, Node 24.22.2, Intel i7-12650H
(16 logical CPUs). Cargo/rustc 1.100.0 are installed; this does not establish that
the native addon linker or cross-platform release toolchain works.

The existing runner uses a fixed local provider and deterministic local tool,
two warmups and five measured samples per case. Setup, explicit GC and disposal
are outside the timed execution. Memory backend is a fixture, not a target to
rewrite. History is 100 messages of 1,024 characters; streaming uses 128 deltas.

| Workload | Median elapsed ms | Commits | Model / tool calls |
| --- | ---: | ---: | ---: |
| tools-short | 78.95 | 117 | 11 / 10 |
| tools-history | 196.16 | 117 | 11 / 10 |
| stream-short | 8.80 | 7 | 1 / 0 |
| stream-history | 18.48 | 7 | 1 / 0 |
| stream-plugins | 30.63 | 7 | 1 / 0 |
| session-tools-history | 290.56 | 116 | 11 / 10 |
| session-stream-history | 38.20 | 6 | 1 / 0 |

These are local sequential medians, not concurrent throughput or p95 latency.
Windows process CPU counters in this run are visibly quantized; elapsed time
uses `performance.now()`. No Rust implementation was measured.

## Remaining work observed

A separate whole-process CPU profile samples 4.53 seconds. Leading self-sample
locations include `freezeSnapshot` (17.0%), `structuredClone` (17.0%), canonical
`encode` (8.6%) and `assertJson` (6.8%). These are sampling locations, not an
additive breakdown of one task. The profile includes import, setup, warmups,
explicit GC and teardown, and does not cover off-thread CPU completely. It
cannot establish an end-to-end speedup ceiling for a native implementation.

The existing commit microbenchmark separately measures the final representative
batch: 122 messages, 119,742 canonical UTF-8 bytes and 33 execution records.

| Operation on that final batch | Median ms/call |
| --- | ---: |
| Validate frozen/proven batch | 0.039 |
| Validate mutable batch | 1.075 |
| Clone checkpoint | 0.166 |
| Canonical JSON | 0.284 |
| SHA-256 of prepared bytes | 0.096 |
| Full fingerprint | 0.510 |

Microbenchmarks use two warmups, five samples and 20 calls per sample. They are
elapsed measurements with promise overhead where applicable. Do not multiply
these medians by commit counts to predict task savings: earlier batches differ,
and these operations also occur at different ownership/storage boundaries.

## Candidate selection

| Area | Decision | Reason |
| --- | --- | --- |
| Canonical preparation plus fingerprint | First candidate for a spike | A complete data batch can cross once and return a small digest; sorting/encoding is measurable. |
| SHA-256 alone | Keep existing implementation | Already calls Node WebCrypto; moving only the digest leaves JSON preparation and conversion in place. |
| Immutable JS graphs and cloning | Keep current ownership boundaries | Rust still has to read/recreate JS values. Borrowing a JS handle does not give Rust ownership of that graph. |
| Agent/Controller/Session, loop and hooks | Keep TypeScript orchestration | Most responsibilities are callbacks, promises, ordering and state ownership; moving them adds repeated language crossings. |
| Capability lookup, IDs and queue bookkeeping | Keep TypeScript | Existing Set/Map/native operations are small; no measured heavy kernel justifies a binding. |

The largest sampled locations are not automatically the best Rust targets.
Reimplementing V8 object cloning/freezing through per-property Node-API calls can
add work while preserving the same JS graph and its lifetime.

NAPI-RS documents owned string conversion, per-element collection conversion and
per-property Node-API access for scoped objects. Include those costs rather than
timing only a Rust function after data has already been converted:
[type conversions](https://napi.rs/docs/concepts/type-conversions).

## Proposed first spike

Keep it under `benchmark/`, with an isolated core build selected through the
existing `TESSAR_BENCH_CORE` runner option. Do not add a public native setting,
change core contracts or ship a new package before evidence supports it.

The experiment is one batch-sized call: JavaScript validation/serialization,
then native canonical preparation plus SHA-256, then a digest back to JS. Compare
the existing TypeScript path, conversion/call overhead and the complete native
path. Returning to JS for every message/property/token is outside the proposal.

Correctness gates precede timing:

- Preserve the current fingerprint bytes, validation errors, model/tool counts,
  commit frequency, hooks and recovery behavior. No checkpoint migration.
- Include JS number formatting, integer-like keys, Unicode/UTF-16 key ordering,
  escaped characters, unpaired surrogates, empty/nested values and rejected
  non-JSON input. A generic Rust JSON serializer is not automatically equivalent
  to `canonicalJson()`.
- Keep fallback behavior for valid cases the native implementation cannot
  represent exactly; never silently normalize them into different hashes.

Run release builds and multiple independent process pairs in opposite order.
Measure complete-task elapsed time, CPU, cold load, event-loop delay, peak RSS
and retained memory. Rust allocations can move outside the V8 heap, so a lower
`heapUsed` alone is not a RAM win. Do not add overlapping memory counters together.

A suggested go/no-go threshold is at least 15% complete-task improvement in the
representative tool/history cases, beyond run-to-run variation, with no material
short-task, memory or correctness regression. This threshold is proposed, not an
agreed product requirement. A faster isolated hash function alone is insufficient.

For larger payloads/concurrency, compare synchronous calls with worker execution;
NAPI-RS [AsyncTask](https://napi.rs/docs/concepts/async-task) runs compute on libuv
workers. Worker scheduling is another cost to measure, not an assumed speedup.

## Integration cost, only if the spike passes

Node-API provides ABI stability across supported Node versions, not a universal
binary for every operating system/CPU/libc. Native release artifacts, fallback
behavior and the repository's current core dependency boundaries need a separate
design before integration. Consumers should retain the TypeScript API and receive
prebuilt supported binaries rather than having to install a Rust toolchain.
See [Node-API ABI stability](https://nodejs.org/docs/latest-v24.x/api/n-api.html#implications-of-abi-stability).

## Artifacts and limits

Ignored raw results are under `benchmark/results/rust-analysis/`:
`typescript-loop.json`, `typescript-loop-profiled.json`,
`typescript-loop.cpuprofile`, `profile-summary.json` and `typescript-commit.json`.

No production source, dependency, public API, binary packaging or Rust source
was changed for this analysis. Rust end-to-end performance, native peak memory,
concurrent load and Linux/macOS behavior have not been measured.
