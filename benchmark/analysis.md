# TypeScript execution overhead: first optimization pass

## Measurement

Measured on 2026-11-20 with Node.js 24.22.2, Windows x64, Intel Core i7-12650H
(16 logical CPUs). Baseline: core sources at `4d159c351f59f1f0f7dc4f895fedcd648b307737`.
Baseline and working-tree core builds used the same TypeScript project settings.
The same benchmark script imported each build's public SDK in separate processes.

Three process pairs ran with alternating before/after order. Each process used
two warmups and five samples per case. The table reports the median of the 15
measured samples per variant, without CPU profiling. Fixtures, explicit GC,
initialization and teardown were outside timing. Session execution was observed
until its input queue and active execution became idle.

These numbers describe the fixed RAM workloads in [agent-loop.mjs](agent-loop.mjs),
not live model services, external tools, disk/database performance or other
frameworks. They are local observations, not performance guarantees. In
particular, short streaming did not improve; long-history tool timings varied
between process batches. Raw samples and CPU profiles remain in ignored
`benchmark/results/`.

## Results

| Workload | Before, ms | After, ms | Before / after |
| --- | ---: | ---: | ---: |
| 10 tools, short history | 153.04 | 126.95 | 1.21x |
| 10 tools, 100 prior messages | 835.92 | 668.89 | 1.25x |
| 128 deltas, short history | 20.15 | 20.34 | 0.99x |
| 128 deltas, 100 prior messages | 157.69 | 86.71 | 1.82x |
| Same stream with 20 handlers | 181.46 | 123.10 | 1.47x |
| Session, 10 tools and history | 869.84 | 709.63 | 1.23x |
| Session, 128 deltas and history | 194.85 | 53.80 | 3.62x |

All samples retained the same model/tool/hook calls, commit counts and snapshot
counts as their corresponding baseline. The scripts also asserted completion
and the exact final text. No checkpoints or observations were removed:

| Cases | Model calls | Tool calls | Commits | Snapshots |
| --- | ---: | ---: | ---: | ---: |
| Agent tool cases | 11 | 10 | 117 | 78 |
| Agent streaming cases | 1 | 0 | 7 | 135 |
| Session tool case | 11 | 10 | 116 | 80 |
| Session streaming case | 1 | 0 | 6 | 137 |

The plugin stream additionally ran all 2,560 expected notification handlers.

## Changes retained

CPU profiling identified repeated JSON validation, cloning and freezing as
prominent work. The changes address repeated work rather than replace the loop:

- `json-snapshot.ts` proves JSON shape during the existing freeze pass and keeps
  only weak references to the proven graphs. Already frozen owned subtrees need
  no repeated traversal. Native objects and sparse/invalid cloned graphs never
  become trusted. The helper is internal, outside the public package exports.
- `assertJson()` can reuse that proof. Caller-owned values still pass the
  existing validation. Public `immutable()` still makes a detached fresh copy,
  including fresh nested objects and preserved aliases within that copy.
- `StateView` copies changed fields, shares proven immutable message arrays,
  and snapshots only the new/replaced message while updating a draft. An
  untrusted previous state falls back to the full-copy path.
- Starting a model without an existing draft keeps the unchanged history array
  instead of filtering and copying it again.

Review found that assuming a validated source always produces valid cloned
descendants was unsafe. Regression tests now cover extra array properties,
accessors, dropped non-enumerable indices, inspection-time source mutation and
cross-snapshot isolation. A full second validation pass was tested but discarded:
it slowed tool workloads. Proving the actual detached graph during freezing
preserves the original input behavior without that additional pass.

## Remaining measurements

- Checkpoint staging/publishing and record-change detection still copy, validate
  and serialize data. This pass does not change their frequency or durability.
  Profile their costs independently before changing record tracking or snapshot
  construction.
- Handler ordering, tool scheduling, locks and recovery remain unchanged. This
  work does not establish a reason to run existing hooks concurrently.
- Measure real storage, concurrent Sessions, HTTP/SSE serialization, heap
  retention and actual tool algorithms separately before making claims about
  those workloads.

## Core baseline after lifecycle and checkpoint work

The follow-up run on Windows x64 with Node 24.22.2 and an Intel i7-12650H used
the same seven memory-backed cases. The median times in case order were 78.95,
196.16, 8.80, 18.48, 30.63, 290.56 and 38.20 ms. The raw loop results, CPU
profile and checkpoint measurements are in the local `results/rust-analysis/`
directory from that run. Rerun `agent-loop.mjs` on the current builds for a
new comparison.
