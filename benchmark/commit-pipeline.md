# Checkpoint and commit analysis

Scope: core commit preparation. The initial analysis is retained below; the
approved implementation and its measured results follow at the end. Public APIs,
checkpoint frequency, fingerprint format and backend implementations are unchanged.
Measurements use Node 24.22.2 on Windows x64.

## Reproduce

Build core, then run:

```powershell
node --expose-gc benchmark/commit-pipeline.mjs | Set-Content -Encoding utf8 benchmark/results/commit-pipeline.json
```

The script runs real Agent executions with fixed prebuilt model chunks, a
deterministic in-memory tool and the memory storage fixture. Assertions check
completion, exact model/tool counts, one publish per submitted commit, unique
commit IDs, record-change accounting and SHA-256 matching the existing full
fingerprint. Results are Git-ignored.

Counters temporarily instrument serialization/cloning and inspect call stacks;
they add overhead. No task latency is reported. Separate microbenchmarks run
after restoring these functions, with two warmups, five samples and 20 calls per
sample. They measure elapsed time per operation, including promise overhead where
applicable, not pure CPU time. All use the final representative batch; they do
not measure the total contribution of that operation over an execution.

## What one commit does

1. Recompute Stream/Turn usage and execution timing.
2. Construct a checkpoint with current history and plugin-state snapshots.
3. Serialize every execution record; include changed records in the batch.
4. Coordinator validates the batch. Each history message is decoded into a
   Message instance, whose constructor validates and clones content/metadata.
5. Send the batch to staging, then look up an existing commit receipt.
6. Publish with revision/ownership checks. On publish failure, look up the
   receipt again to handle a commit whose response was lost.
7. Save record versions and clone the checkpoint into the working frame.
8. Dispatch `checkpoint.committed`.

Storage staging independently validates/snapshots/fingerprints its input. It is
a separate trust boundary; coordinator validation does not authorize deleting
its checks. Backend implementation costs are not benchmarked in isolation here.

## Repeated work observed

| Prior messages | Tools | Model calls | Commits | Post-publish checkpoint clones | Coordinator message-content clones |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 1 | 7 | 6 | 9 |
| 100 | 0 | 1 | 7 | 6 | 609 |
| 100 | 10 | 11 | 117 | 116 | 12,949 |

History messages contain 1,024 characters each. The final tool-case checkpoint
has 122 messages. Content-clone calls equal decoded-message counts for this
fixture, not arbitrary inputs with different metadata/normalization. These are
repeated visits, not 12,949 unique messages or measured heap bytes. The initial
Thread creation commit explains the difference between commits and post-publish
clones. Coordinator counts exclude the memory fixture's validation work.

The 117 commits comprise 1 ThreadCreated, 1 InputCommitted, 93
ExecutionTransition, 21 MessageCommitted and 1 Terminal. There are 31 batches
with no changed records; this does not establish that those commits are no-ops.
Checkpoint state independently contains execution phase, budgets, cursors,
history and plugin state. Frequency changes need a separate recovery analysis.

The tool case serializes 2,060 record entries, while submitting 150 changed
versions. 1,910 serializations (92.7%) reproduce unchanged content. That is a
work-count ratio, not a percentage of execution time saved by an optimization.

Usage is aggregated 230 times inside commit preparation and 24 times outside it.
These are individual Stream/Turn aggregations, not provider calls. TurnBoundary
refreshes usage immediately before commit refreshes it again. The final outcome
also consumes usage before its terminal commit, so that earlier calculation
cannot simply be deleted.

## Relative costs

The final tool-case batch contains 122 messages, about 120 KB canonical JSON and
33 execution records. Representative medians from this local probe were roughly:

| Operation | Milliseconds per call |
| --- | ---: |
| Validate the mutable batch | 1.03 |
| Validate an already frozen/proven JSON snapshot | 0.39 |
| Clone the checkpoint | 0.16 |
| Serialize the final 33-record set | 0.05 |
| Canonical JSON from the frozen batch | 0.27 |
| SHA-256 with bytes already prepared | 0.09 |
| Full fingerprint from the frozen batch | 0.48 |

Frozen validation still clones content 122 times in this fixture. JSON-proof
reuse skips traversal but does not avoid constructing each Message again.
Snapshot preparation and digest-input UTF-8 preparation are excluded from their
respective isolated measurements. This is not a realized whole-commit speedup.
Do not add/subtract these medians or multiply them by execution counters to
predict task latency. Final-record-set timing is not the total cost of every
earlier, smaller record set. See the raw local result for individual samples.

## Recommended implementation order

1. **Avoid constructing Messages solely to validate owned snapshots.** Share
   existing semantic validation rules; keep schema, JSON, role, parts,
   duplicate-ID, tool correlation and terminal unresolved-call checks. Public
   decoding must still return Message instances. Use a read-only fast path only
   for proven JSON snapshots; retain the existing normalization/clone path for
   untrusted or unusual graphs until equivalent behavior is demonstrated.
2. **Reuse owned immutable history across checkpoint transitions.** Audit
   admission, recovery, message append, plugin state and storage references.
   Copy changed state while preserving the intentionally mutable execution
   position and its identity. A shallow copy of today's mutable graph is unsafe:
   later frame/storage changes must not alter earlier checkpoints. This work
   enables repeated use of the proven-snapshot validation path above.
3. **Remove proven duplicate usage calculations.** Start with TurnBoundary's
   immediate refresh before commit. Keep `finish()`'s refresh: it captures
   `outcome.usage` before the terminal commit replaces `directUsage`. Persisted
   usage and hook order must remain unchanged.
4. **Re-measure before adding dirty tracking.** The serialization ratio is high,
   but record serialization is cheaper than validation/history work in this
   fixture. Producers mutate records directly across loop, tool executor,
   tracked services, resume, cancellation and interruption paths. Marking only
   `put()` would miss subsequent status/result/usage changes.
5. **Keep native SHA-256 and its fingerprint format.** Revisit canonical
   preparation only after measuring earlier changes. Replacing the digest with
   Rust alone leaves canonicalization, UTF-8 encoding and copies in place.

Compatibility details matter: current validation accepts string message content
through constructor normalization, and rejects a function stored on an extra
array property with `DataCloneError`, even though `assertJson()` ignores array
extras. The probe asserts both behaviors. Simply iterating raw parts or calling
`assertJson()` is not an equivalent replacement for decoding.

First-phase scope should be owned-snapshot validation/history reuse plus safe
duplicate calculations. It excludes merged commits, dropped checkpoints,
proxy-based mutation tracking, new backend contracts and Rust bindings.

Required checks for implementation: malformed-message acceptance/errors,
mutation isolation including retained storage references, concurrent tools and
plugin-state commits, staged retries, revision/ownership failure, lost publish
responses, suspension/resume and process-restart recovery. Preserve the fixed
fixture's model/tool/commit counts and final answers.

## Implemented and verified

- Shared content rules between normalization and validation. `validateBatch()`
  uses read-only validation for proven JSON snapshots; untrusted/unusual graphs
  retain constructor normalization and clone-error behavior. Public decoding and
  encoding preserve their allocation/isolation contracts.
- Admission/recovery already detach loaded checkpoints. Core now freezes their
  owned state and shares unchanged immutable history across checkpoint transitions.
  New message arrays preserve prior snapshots. Native/unproven descendants retain
  the previous deep-copy fallback.
- Execution position is copied into the checkpoint submitted to storage; the
  working mutable position keeps its identity. This also stops retained staged
  checkpoint budgets/timing from changing with later execution.
- Only TurnBoundary's duplicate usage refresh was removed. The finish() refresh,
  all commit boundaries, fingerprinting and record-change detection remain.
- Root message exports are explicit to keep the new internal validator private.
  Runtime export keys exactly match the saved baseline.

For the same 100-history/10-tool probe:

| Counter | Before | After |
| --- | ---: | ---: |
| Commits | 117 | 117 |
| Model calls / tool calls | 11 / 10 | 11 / 10 |
| Submitted changed record versions | 150 | 150 |
| Record serializations | 2,060 | 2,060 |
| Whole-checkpoint clones after publish | 116 | 0 |
| Message entries in those post-publish clones | 12,949 | 0 |
| Coordinator message-content clones | 12,949 | 0 |
| Usage aggregations outside commit | 24 | 2 |

Zero whole-checkpoint clones does not mean zero cloning: mutable execution
position still gets a separate snapshot, backend ownership copies are retained,
and unusual data uses the fallback. Validation still checks every message's
semantics and cross-message relationships; zero content clones means those
checks no longer construct Message instances for the owned JSON path.

### Full fixed-task execution benchmark

Unprofiled `agent-loop.mjs`, three independent before/after process pairs, two
warmups and five measured samples per process. Values below are medians pooled
over 15 samples per variant. The baseline build includes all preceding lifecycle
optimizations, so this table measures only the commit changes above.

| Workload | Before ms | After ms | Ratio |
| --- | ---: | ---: | ---: |
| tools-short | 125.54 | 90.99 | 1.38x |
| tools-history | 422.93 | 205.76 | 2.06x |
| stream-short | 9.48 | 9.26 | 1.02x (little change) |
| stream-history | 47.96 | 39.06 | 1.23x |
| stream-plugins | 63.23 | 54.18 | 1.17x |
| session-tools-history | 411.22 | 192.13 | 2.14x |
| session-stream-history | 27.51 | 17.41 | 1.58x |

Final outputs and every measured model/tool/handler/commit/render-snapshot count
match across all before/after samples. The frozen-batch validation microbenchmark
also went from about 0.39 to 0.05 ms per call for 122 messages; mutable external
data intentionally retains the legacy path. These are local synthetic workloads
without provider/network latency or filesystem tools, not a general task-speed
claim for deployed applications or a comparison with other frameworks.

Local artifacts: `results/commit-before-core/dist`, `commit-before-loop.json`,
`commit-after-loop.json`, their `-2`/`-3` runs, `commit-loop-summary.json`,
`commit-pipeline.json` (initial probe), and `commit-after-pipeline.json`.

Typecheck, workspace build and dependency boundaries passed. Package tests:
1,099 passed, 77 skipped. Integration tests: 89 passed. Independent scoped review
found no concrete issues. Remote database latency, live MongoDB runs,
concurrent Session throughput, large tool payloads and long-lived heap retention
remain outside these measurements. Dirty tracking and Rust remain deferred.

### PostgreSQL correctness follow-up

Ran the existing PostgreSQL state/backend suite on local PostgreSQL 17.11,
port 5432, database `test`: **32 tests passed, zero failed or skipped**. This
includes storage conformance, durable Agent/tool traces across reopening,
concurrent retries, Session CAS, ownership/fencing and expired-lease rollback.

The database did not exist and was created for this run. Per the user's request,
31 generated `tessar_test_<uuid>` schemas and their final data were retained.
An ignored copy of the existing backend test file omitted only its teardown
`DROP SCHEMA`; connection shutdown and test assertions remained in place.
The original test source and database adapter were unchanged. Runner/config and
JSON results are in `benchmark/results/postgresql-*`; credentials are not stored
in these artifacts or repository files.

Only `plpgsql` is installed; state/checkpoint tests need no additional extension.
Vector/BM25 tests were not run. These are correctness results. The execution-speed
table above uses memory; live PostgreSQL timing measurements follow below.

### PostgreSQL execution timing

Ran the same fixed-task runner on PostgreSQL 17.11 at localhost:5432, database
`test`, with fsync=on, synchronous_commit=on and shared_buffers=128MB. Server
settings and the PostgreSQL adapter implementation were unchanged.

Two independent process pairs used opposite orders: baseline then optimized,
followed by optimized then baseline. Each process/workload had two warmups and
five measured samples, giving 10 samples per variant/workload. Pooled medians
use the average of the two middle values for the even sample count.

| Workload | Before ms | After ms | Less elapsed time |
| --- | ---: | ---: | ---: |
| tools-history | 1,863.22 | 1,449.97 | 22.2% |
| session-tools-history | 1,860.80 | 1,441.83 | 22.5% |
| stream-history | 160.86 | 129.55 | 19.5% |

History contains 100 messages of 1,024 characters each. Tool cases retain 11
model calls and 10 tool calls, with 117 commits through Agent / 116 through
Session. Streaming retains one model call and seven commits. Render snapshot,
handler and commit counts and final outputs match in every sample.

The baseline is the saved build immediately before the commit optimizations,
including earlier lifecycle changes. A Node resolver hook binds both Agent and
the adapter's core imports to the selected build, including validation and
fingerprinting helpers. Both variants use the same PostgreSQL adapter and timer
boundaries. Pool/schema setup and initial Session history setup are outside the
timed interval, matching the memory benchmark. Timed execution includes live
SQL transactions and durable publication; provider chunks/tools remain fixed
in-memory fixtures. Reported Node CPU times do not include PostgreSQL server CPU.

All 84 benchmark schemas/data (including warmups) were retained, separately from
the 31 schemas from correctness tests. No URL or password is written to results.
Artifacts: `results/postgresql-before-loop.json`, `postgresql-after-loop.json`,
their `-2` runs, and `postgresql-loop-summary.json`. See README for runner options.

These are local sequential workloads. They are not concurrent-throughput or
remote-database measurements. Database I/O, transaction work and backend JSON
processing remain in the pipeline, so the observed elapsed reduction differs
from the memory fixture. An injected setup-failure self-check verifies pool
closure; the default memory path also passed a stream workload after the runner
change. No production/core code changed during this database measurement pass.
