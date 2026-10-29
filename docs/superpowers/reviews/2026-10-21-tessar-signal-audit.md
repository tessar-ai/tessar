# Signal lifecycle and acceptance audit

Date: 2026-10-21. The findings below describe the original implementation before
repair. The user subsequently clarified memory acceptance matching followUp and
approved the repair, including string input for followUp. See the repair section
at the end for implementation and current verification; historical reproductions
must not be read as the repaired behavior.

## User intent and current discrepancy

Signal is additional user-message input. Unlike `session.followUp()`, which waits
for an execution to finish, signal becomes eligible inside the current execution
at the next safe model boundary after the complete outstanding tool-result group.
An idle selected Session Thread starts processing. The public route, XML wrapping,
metadata, fixed user role, and persistence flag are already defined.

The implementation added a much stronger receipt dependency: persisted signal
reception waits for admission, checkpoint publication, and completion of that
commit's notification hooks. Even nonpersisted input waits for admission. These
dependencies create both circular waits and unnecessary rejection of independent
message arrivals. They are not inherent requirements of a message-input primitive.

The current written spec explicitly says persisted acceptance is acknowledged
after a checkpoint commit. Any proposal to return immediately after RAM enqueue
would change that contract. This report does not silently make that change.

## Evidence and limitations

The core was rebuilt directly with TypeScript before probing public package
imports. Existing and additional diagnostic workers load real external `.mjs`
plugins with `PluginManager.load()`. Plugins obtain the Agent through the hook
registry. Diagnostic gates allow a stuck hook to be released after observing a
cycle; no production source is patched to make a reproduction finish.

Commands verified in this audit:

```text
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json
node .superpowers/signal-deadlock/check.mjs
node .superpowers/signal-deadlock/audit-extra/check.mjs
node node_modules/vitest/vitest.mjs run --configLoader native --pool threads packages/core/test --maxWorkers 4
node node_modules/vitest/vitest.mjs run --configLoader native --pool threads tests/integration/signal-persistence.test.ts tests/integration/persistence-restart.test.ts --maxWorkers 4
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
node scripts/check-boundaries.mjs
git diff --check
```

- 46 original diagnostic scenarios reproduced their expected current outcomes.
- 12 additional diagnostic scenarios reproduced the findings below: 58 total.
- 235 core tests passed, including the 25 focused signal tests.
- Six SQLite persistence/restart integration tests passed.
- Typecheck, core build, boundaries and whitespace checks passed. Git reported
  existing LF/CRLF conversion notices during the whitespace check.
- The additional fault scenario passed with both Memory and SQLite storage.
- Providers were scripted; there were no live model, GitHub or Slack requests.
- PostgreSQL/MongoDB were not exercised by this audit. No real process-crash
  recovery test was added for the post-commit rejection finding.

Passing existing tests does not validate the missing callback/lifecycle cases.
The probes assert the bugs' current behavior, not that a repair has passed.
Ignored probe scripts/results remain under `.superpowers/signal-deadlock/` and
`.superpowers/signal-deadlock/audit-extra/` for local reproduction.

## Findings

### P1: admission can wait for its own signal receipt

Locations: `packages/core/src/agent.ts:309-321`,
`state/thread-operations.ts:21-43`, `engine/signals.ts:89-98`,
`engine/execution.ts:221-224`.

A Controller-bound direct Agent call reserves its signal mailbox before
`prepareThread()`. That function awaits `thread.prepare` and `thread.started`.
If either callback awaits a persisted signal addressed to that same reserved
Stream ID, its receipt awaits admission, but admission awaits the callback:

```text
Agent admission -> Thread hook -> sendSignal -> mailbox.ready
       ^                                      |
       +------------- InputCommitted ---------+
```

There is no frame during Thread preparation, so the `frame && !frame.admitted`
guard does not run. Nonpersisted signal reception also reproduces the cycle
because it unconditionally awaits the same ready promise.

### P1: two Streams can form the same cycle across targets

Additional probe: `cross-stream-admission`.

Two concurrent Streams of one Agent each run a Thread-preparation hook. Each
hook awaits a persisted signal sent to the other reserved Stream. Both receipts
stay pending and neither provider is called. After a diagnostic hook escape,
both receipts resolve and both executions complete.

A guard that only compares sender Stream ID to target Stream ID would miss this
case. `AsyncLocalStorage` can propagate origin information; it does not prove
the absence of cross-execution wait cycles. The earlier same-target guard
proposal is therefore insufficient.

### P1: abort and disposal do not break the reproduced admission cycle

Locations: `agent.ts:321`, `agent.ts:419-425`.

Additional probes: `abort-self-thread-prepare`, `abort-self-thread-started`,
`abort-transient-thread-prepare`, and `dispose-self-thread-prepare`.

Calling `Stream.abort()` leaves both receipt and iterator completion pending
until the diagnostic escape releases the hook. Calling `Controller.dispose()`
also stays pending. Shutdown aborts registered active frames, then waits for
execution jobs before clearing signal mailboxes; these preparing jobs have no
frame yet. This observation concerns the reproduced signal cycle, not a claim
that JavaScript can forcibly terminate arbitrary plugin callback code.

### P1: a post-publication hook failure can reject an already-persisted signal

Locations: `engine/checkpoint.ts:68-75`, `events/dispatcher.ts` error handling,
`engine/signals.ts:139-148`.

Additional probes: `persisted-receipt-rejected-after-commit` and
`sqlite-receipt-rejected-after-commit`.

With the model independently paused, send a persisted signal. Its checkpoint
publishes successfully. The diagnostic `checkpoint.committed` callback then
throws a `TessarError("StorageUnavailable", ...)`, exercising the dispatcher's
existing notification-error propagation branch. This is injected failure after
a real successful write, not an actual database outage.

Observed with both storage backends:

- `sendSignal()` rejects with the injected storage error.
- The committed checkpoint still contains that pending signal.
- `acceptSignal()` removes the signal from the in-memory pending list.
- Releasing the model completes the execution without sending that signal in a
  subsequent provider request.

The caller's error and durable state therefore disagree about acceptance. A
crash in this interval could make recovery observe input the caller saw rejected;
that is an inference from stored state, not a crash replay demonstrated here.
An eventual terminal commit in the observed uninterrupted run removes pending
execution state. A notification failure must not be treated as rollback of an
already-published checkpoint.

### P2: independent incoming messages can be rejected during ordinary startup

Locations: `engine/signals.ts:89-92`, `session.ts:115-142`.

The original external-during-input.prepare probe rejects despite no callback
dependency cycle. The added `idle-thread-signal-burst` probe starts an idle
Session Thread with one external notification, pauses its input preparation,
then submits a second independent notification. The first is accepted; the
second rejects with `InvalidTransition` and is absent from history.

An external Thread-targeted arrival during a paused finalization hook also
rejects with `AlreadyTerminal`, because `agent.ts:243` uses the target's global
`hookDepth`. A completed Stream target should reject; a Thread route needs an
explicit transition policy so an independent sender is not mistaken for the
closing callback itself.

### P2: signal implementation changes notification sequencing without any signal

Locations: `engine/checkpoint.ts:68-75` and its Git diff.

The signal implementation moved `checkpoint.committed` and `thread.updated`
dispatch out of the commit serialization queue to allow a notification callback
to await a nested signal commit. This affects every execution using `commit()`.

The `parallel-commit-notifications-without-signals` probe runs two tools and
never calls `sendSignal()`. While the revision-10 notification is paused, the
revision-11 notification enters and exits:

```text
enter:10
enter:11
exit:11
```

Concurrent notification callbacks and revision completion out of order are
therefore confirmed current behavior. The previous queue included notification
dispatch before releasing the next commit. Whether consumers relied on that
serialization needs to be considered explicitly; passing core tests does not
establish compatibility. Do not broadly redesign dispatch just to patch signal.

## What remains supported by existing checks

The checked model/tool-I/O arrivals complete without waiting for the provider or
tool to finish. Signals are applied after a complete tool-result group; metadata
and multipart normalization remain covered. Tested transient input is excluded
from checkpoints, and the SQLite suspended-signal restart test preserves durable
input without replay. These successful cases do not cover the failures above.

## Design consequence

The input boundary should be reasoned about as:

```text
validate and route -> accept message -> persist as specified -> apply at safe boundary
```

It must not require model processing or notification-handler completion to
acknowledge acceptance. Preserve the distinction from followUp's next-execution
queue and the existing rule against inserting inside a tool-result group.

Before implementation, resolve the receipt contract explicitly:

| Contract | Benefit | Cost or constraint |
| --- | --- | --- |
| Receipt means accepted into RAM | Matches simple message submission; receipt need not depend on admission hooks or a model turn | Changes the current written persisted-receipt guarantee; crash before persistence can lose acknowledged input |
| Receipt means durably committed pending input | Retains the current written guarantee | Cannot await that receipt from preparation that must finish before the destination checkpoint can exist; requires explicit restrictions or a different durable ingress design |
| Independent durable ingress before execution admission | Could support durable acceptance without waiting for execution preparation | New durable inbox/routing/lifecycle contracts; substantially larger than the requested minimal primitive |

The three conditions "destination does not exist until the hook returns",
"receipt requires destination persistence", and "the hook awaits the receipt"
cannot all hold. Origin tracking can detect or conservatively reject some such
calls; it does not remove this dependency.

Given the user's clarification that signal is message submission into current
work, evaluate a simple acceptance boundary first. Do not introduce
AsyncLocalStorage or widen the general hook runtime merely to defend the present
coupling. If RAM acceptance is selected, document the durability change before
editing the implementation. If durable acceptance is retained, document the
restrictions and prove them against cross-Stream cases as well as same-Stream
calls. No new public method or parameter is proposed by this audit.

## Required repair verification

- Reproduce and remove the admission and cross-Stream circular waits under the
  selected receipt contract, including nonpersisted input.
- Verify abort/dispose settle pending receipts and execution resources.
- Accept independent bursts during Thread startup and define closing-Thread
  behavior without silently targeting the wrong execution.
- Separate publication results from post-commit notification failures; test
  success, failure before publication, failure after publication and restart.
- Preserve or explicitly specify commit-notification ordering for execution
  paths that never send a signal.
- Recheck concurrent persisted/transient ordering, tool-result grouping,
  suspension/resume, stop/limits, provider errors and checkpoint history.
- Verify the chosen behavior through both direct Agent streams and live Session
  subscriptions with externally loaded plugins.

This audit adds only diagnostics and this report. It does not change runtime
source, the API reference, the approved signal spec, Node boundaries, database
schemas, versions, Git commits, or publication state.

## Repair after user clarification

The user confirmed that signal is message submission like followUp, with the
different application boundary. The checkpoint-durable receipt requirement was
removed from the spec and implementation. This is an explicit contract revision,
not a claim that RAM acceptance is durable.

- `session.followUp(text)` constructs a HumanMessage internally. Explicit message
  objects and readonly message arrays remain supported. The queue and execution
  behavior are unchanged; tests include empty text, FIFO, provider input and
  persisted history. Session hook handles inherit the updated signature.
- Signal receipts return after in-memory reception. Pending storage writes and
  execution startup are not part of the caller's awaited receipt. Invalid routes
  still reject synchronously within the receiving method. Later startup/write
  failures use execution errors and diagnostics.
- Removed hookDepth guards and the mailbox-close wait from the receiving path.
  No AsyncLocalStorage, runtime dependency or boundary exception was added.
- Restored checkpoint notification callbacks to the existing commit queue.
  The probe with no signal now shows revision 10 remaining alone until released,
  instead of revision 11 entering and exiting while revision 10 is blocked.
- A post-publication callback failure no longer makes the public receipt fail or
  removes the published message from in-memory pending state. The execution reports
  the failure and the committed pending input remains available for recovery.
- Closing Thread input is received by its Session and can start after the old
  execution closes. A regression test observes both executions and verifies that
  the second request/history contains the incoming message on that same Thread.
- Suspended writes use the existing per-mailbox offline queue for ownership
  handoff with resume, recovery and cancellation. A further deterministic test
  first reproduced `Thread has active owner` when a signal arrived while resume
  was reading its checkpoint; the shared queue and rechecked frame attachment
  remove that race. This is internal coordination, not a new public protocol.
- Persisted input is still checkpointed before model-context application. Input
  accepted into RAM before the write can be lost on startup failure or crash,
  matching the reception/processing distinction of followUp. Suspended durable
  writes continue without automatically resuming work.

Current verification:

- Full package test run: 335 passed, 39 skipped. An earlier run had four
  `spawn EPERM` failures in `packages/plugins/test/index.test.ts`; the full rerun
  passed all four as part of the 335.
- All 58 external-plugin probes were rerun against rebuilt package exports with
  repaired expectations. The original 46 now have 44 fulfilled receipts, the two
  intended closed-Stream rejections, and zero pending receipts. All 12 additional
  checks pass; cross-Stream receipts resolve, abort/dispose complete, both idle
  notifications are retained, and commit callbacks remain serialized.
- Seven focused integration tests passed: `signal-persistence.test.ts`,
  `persistence-restart.test.ts`, and `parallel-tools.test.ts`.
- PostgreSQL storage suite: 29 passed. MongoDB: 17 skipped without configured URL;
  those skips do not verify MongoDB behavior.
- All eight package/application projects compile directly with TypeScript.
  Test typecheck, boundaries and generated API reference checks pass.
- Built public consumers `tests/fixtures/signal-consumer.ts`,
  `tests/fixtures/agent-composition.ts`, and the headless fixture run directly.
- `pnpm build` still hits `spawn EPERM` launching its child compiler, although
  direct compilation of each project succeeds. Full integration was attempted
  twice and remains 7 passed, 23 failed, 3 skipped. The failures are in
  `examples.test.ts` (3), `plugin-distribution.test.ts` (4), `release.test.ts` (10),
  `public-imports.test.ts` (3), and `tool-suspension.test.ts` (3). These fail at
  child-process creation (`spawn EPERM` / null child status), not signal
  assertions. They have not been represented as passing or changed to skip.

Repaired local probe commands and logs:

```text
node .superpowers/signal-deadlock/check-repaired.mjs
node .superpowers/signal-deadlock/audit-extra/check-repaired.mjs
.superpowers/signal-deadlock/repaired-results.json
.superpowers/signal-deadlock/audit-extra/repaired-results.json
.superpowers/signal-deadlock/package-tests.log
```

Guides, spec, plan and API-REVIEW.md now describe memory receipt semantics. No
database schema, provider protocol, package version, commit or publication changed.
