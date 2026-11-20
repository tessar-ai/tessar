# Core lifecycle review

Scope: `packages/core` only. No built-in plugin, server/client or database adapter
implementation is reviewed here. The memory fixture records calls that core
makes through its storage contract; it is not a backend performance review.
The hydration optimization below is implemented; registration and other paths
remain measurement targets.

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

Remaining: active hydration still loads the Thread's tool records and filters by
stream ID. Changing that to filtered pages needs to preserve ordering. A snapshot
represents the scoped head observed during loading; it does not lock the Thread
or subscribe a restored Session to another handle's future execution events.
No backend implementations or persistence formats changed.

## Capability registration: second priority under large registries

`PluginHost.attach()` reconstructs the existing capability list on every
registration, then scans it for a conflicting kind/ID. Repeated registration
therefore revisits a growing list.

Observed Controller initialization with one synthetic plugin whose only work is
registering empty numeric capabilities, two warmups and five measured samples:

| Capabilities | Median initialization, ms |
| ---: | ---: |
| 100 | 0.464 |
| 1,000 | 9.970 |
| 5,000 | 117.056 |

The large case is a stress case, not evidence that ordinary plugin setups are
slow. An index could avoid repeated flattening/scanning, but must cover late
registrations, attach failure rollback, detach and captured execution leases.
Do not assume registration happens only synchronously inside setup.

## Other core paths worth measuring

- `inputMessages()` currently encodes, decodes and encodes every message. Check
  history import/Thread creation with large inputs before changing that path;
  class-to-wire normalization and plain-data validation must remain intact.
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

Beyond the completed hydration change, these are measurement targets, not a
need for Rust. Cold process import, busy cancellation, large observer fanout,
concurrent lifecycle operations and heap retention have not been benchmarked.
