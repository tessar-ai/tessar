# Core lifecycle review

Scope: `packages/core` only. No built-in plugin, server/client or database adapter
implementation is reviewed here. The memory fixture records calls that core
makes through its storage contract; it is not a backend performance review.
The hydration, capability registration and input normalization changes below are
implemented. Remaining measurement targets are listed separately.

Run after building core:

```powershell
node --expose-gc benchmark/core-lifecycle.mjs | Set-Content -Encoding utf8 benchmark/results/core-lifecycle.json
```

## Session and Thread hydration: first priority

Measured before and after the hydration change with two idle Threads containing
100 messages of 1,024 characters each:

| Operation | Thread reads, original → first pass → final | Checkpoint reads, original → final | Model-attempt record lists, original → final | Other |
| --- | ---: | ---: | ---: | --- |
| `thread.snapshot()` | 2 → 2 → 1 | 1 → 1 | 1 → 1 | None |
| `session.thread.switch()` | 5 → 4 → 2 | 2 → 1 | 2 → 0 | 1 Session read and 1 Session CAS |
| `controller.getSession()` | 3 → 3 → 2 | 1 → 1 | 1 → 0 | 1 Session read |

These are storage-port invocation counts, not physical database round trips.
The inspection asserts selected Thread and restored message count. Its operation
timings are single observations, so they are not used as latency estimates.
This comparison used Node 24.22.2 on Windows x64, with the preceding immutable
state optimization already present in both builds. Local captures are
`results/lifecycle-before.json`, `results/lifecycle-after.json`, and the final
follow-up comparison `results/switch-before.json` / `results/switch-after.json`
(Git-ignored). No latency improvement is claimed from these single observations.

Implemented:

- An internal Thread snapshot reads one scoped head and its referenced immutable
  checkpoint without fetching model-attempt history. Session restoration,
  resume/recovery model selection and inactive-handle abort use this read.
- Public `Thread.snapshot()` still aggregates usage; generated Thread and Session
  declarations are identical to the build before this change.
- `Session.thread.switch()` reads the target before the authorization hook to
  reject unavailable or foreign Threads before invoking plugins. Session CAS
  already validates the selected Thread's existence and scope before publishing;
  an extra application-level read after the hook was redundant. This contract is
  documented on the storage port and covered by storage conformance tests.
- After CAS, hydration reads the scoped head again and loads its checkpoint.
  This is the second Thread read; it sees changes during the hook/CAS instead of
  caching old state. There is no further head read during snapshot construction.
- Activity, history, stream/tool records and pending interrupt are tied to that
  checkpoint. Previously a later head/record read could mix old history with a
  newer execution. Scope is checked before loading the checkpoint, and a missing
  checkpoint after concurrent purge still raises `ThreadNotFound`.
- Queue blocking uses hydrated activity. If a later `followUp()` encounters a
  blocked Thread, it rechecks current scoped activity before queuing, avoiding a
  permanent block after another execution completes. This read is conditional;
  it adds no read to switching or ordinary idle follow-up. Selection and lifecycle
  are checked again after that await.

Regression tests cover restored history, public usage, the two-read switch path,
concurrent history changes during CAS, deletion in the authorization hook,
concurrent execution start/completion while loading, activity changes during CAS,
purge during loading, and a selection change during blocked-input refresh.
Existing Session and runtime-state tests cover scope, stale Session handles,
busy switching and suspended tool restoration/resumption.

### Active-stream tool records

Hydration now uses the existing execution-page query with `streamId` and a fixed
`atCheckpointId`. Pages contain up to 200 records; core follows every cursor and
maps the records directly to rendering fields before publishing the new view.
No extra Thread head reads are needed. Page order follows the existing storage
paging contract, also used by the durable adapters' record lists.

Run `node benchmark/session-hydration.mjs`. A real scripted execution completes
20 historical tool calls, then suspends on one tool in a new stream:

| Tool data returned through storage port | Before | After |
| --- | ---: | ---: |
| Records | 21 | 1 |
| Serialized JSON bytes in this run | 13,080 | 446 |
| Restored tools | 1 | 1 |

JSON bytes describe the returned rows, not measured heap usage or network traffic.
This does not measure or change database implementations' internal query work.
For more than 200 active records, pagination trades additional calls for bounded
page size; it never truncates the rendered tool list.

Tests additionally seed 210 historical and 205 active records, verify both pages,
ordering, interrupt state and a concurrent update after page one, and verify that
a later-page failure leaves the previous rendering snapshot intact.

A snapshot represents the scoped head observed during loading; it does not lock
the Thread or subscribe a restored Session to another handle's future execution
events. No backend implementations or persistence formats changed.

## Capability registration: second priority under large registries

Previously `PluginHost.attach()` reconstructed the existing capability list on
every registration, then scanned it for a conflicting kind/ID. It now checks a
Set of encoded kind/ID pairs. IDs are reserved while setup awaits, including
against late registrations from an already attached plugin. Rollback and detach
release IDs immediately; captured leases still retain their original values.

Observed Controller initialization with one synthetic plugin whose only work is
registering empty numeric capabilities, two warmups and five measured samples:

| Capabilities | Before, ms | After, ms |
| ---: | ---: | ---: |
| 100 | 0.490 | 0.189 |
| 1,000 | 9.599 | 0.607 |
| 5,000 | 111.824 | 2.418 |

The large case is a stress case, not evidence that ordinary plugin setups are
slow. The index stores one key per reserved capability; it does not copy the
capability values. Regression tests cover initial values, key-pair separation,
pending setup collisions, rollback, detach, retained leases and saved detached
contexts. Local results: `results/capabilities-before.json` / `capabilities-after.json`.

## Input normalization

`inputMessages()` retains its initial encode/snapshot and decode/constructor
validation. The final wire projection now freezes a fresh plain wrapper around
the constructor's owned immutable fields, rather than cloning the whole message
again. Public `MessageCodec.encode()` retains its detached-copy behavior.

Run `node --expose-gc benchmark/message-input.mjs`. Each sample normalizes 2,000
messages of 1,024 text characters plus metadata and provider state, with two
warmups and five samples:

| Input | Before median, ms | After median, ms |
| --- | ---: | ---: |
| Message classes | 49.433 | 33.888 |
| Wire messages | 47.644 | 33.680 |

These measure normalization alone, not complete Thread creation, agent-task
latency or throughput. The shared helper serves admission, Session follow-up and
Thread creation. Tests cover the removed clone, mutable caller isolation,
plain/frozen output, provider state, ignored extra fields, tool correlation and
invalid input. Local results: `results/input-before.json` / `input-after.json`.

## Other core paths worth measuring

- Registry capture creates handler/value arrays, while lookup and event
  selection scan them. Profile with many registrations and active executions
  before introducing indexes or caches; old leases must retain their captured
  registrations through detach.

## Existing lifecycle choices to preserve

- Controller initialization and disposal already reuse their in-flight promises.
- Controller disposal starts Session closure together, aborts Agent work, then
  waits for shutdown and cleanup. The idle fixture shows no storage reads for
  closing a Session or Controller; this does not characterize busy shutdown.
- Plugin initialization and disposal order are part of observable behavior.
  They must not be parallelized simply to shorten an empty-fixture benchmark.
- Model handles and the bundled catalog already have reuse mechanisms; no
  repeated catalog copy per Controller was found in the inspected constructor.

Beyond the completed changes above, these are measurement targets, not a
need for Rust. Cold process import, busy cancellation, large observer fanout,
concurrent lifecycle operations and heap retention have not been benchmarked.

## Profile after these changes: checkpoint/commit is the next core target

Captured with `node --expose-gc --cpu-prof --cpu-prof-dir=benchmark/results
--cpu-prof-name=core-after-lifecycle.cpuprofile benchmark/agent-loop.mjs`.
All seven workload self-checks passed. This profile covers the whole process,
including setup, warmups and explicit GC; its timings are not latency benchmarks.
It also includes the memory storage fixture, which is outside the implementation
optimization scope here.

The profile still spends substantial samples in structured cloning, JSON
validation/freezing and the canonical encoder in `state/commit.ts`. Connected
core code explains the remaining work:

- `engine/checkpoint.ts:commitNow()` stringifies every record in the execution
  on every commit to detect in-place changes, recomputes usage, and clones the
  checkpoint after publication. Record producers currently mutate data in place,
  so replacing this with dirty tracking requires auditing every producer.
- `state/commit.ts` validates each batch and canonicalizes/sorts JSON for its
  fingerprint. The SHA-256 digest already uses native Web Crypto; moving only
  hashing to Rust would leave the serialization work in place.
- Event dispatch and registry lookups are visible but less prominent in this
  workload. Their observed presence alone does not justify another index/cache.

Investigate redundant preparation and copying around a commit next, preserving
all durable publication, ownership, retry and recovery boundaries. This profile
does not authorize dropping checkpoints or reducing validation at storage trust
boundaries, and does not yet establish a Rust implementation target.

The follow-up [commit analysis](commit-pipeline.md) measures these operations
separately and proposes an implementation order. It changes no commit behavior.
