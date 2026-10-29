# SDD ledger — plan: docs/superpowers/plans/2026-10-21-tessar-signal-plan.md

Pre-flight: Tasks 1→2 share SendSignalOptions and immutable MessageData; consistent.
Pre-flight: Tasks 2→3 share pendingSignals, commit mutation and context merging; consistent.
Pre-flight: Tasks 2/3→4 share routing lifecycle and pending persistence; initial idle signals need the same durable/transient handling as active input.
Ruling: Work in the requested D:\tessar checkout on its existing release branch and preserve the dirty baseline — approval names this workspace; git metadata is read-only, so no worktree/commit scripts run.
Ruling: Keep this ledger until completion because no commits are requested; do not delete execution evidence.
Task 1: complete — normalization RED (missing module) → GREEN (3 tests); typecheck passes.
Tasks 2/3: direct Stream acceptance, pending commits, transient overlays and loop boundaries implemented; focused tests green. Remaining final verification/review pending.
Task 4: Session idle/live/suspended routing implemented; SQLite restart test RED (ownership released before signal commit) → GREEN after draining before lease release.
Ruling: Use AsyncLocalStorage only to reject hooks awaiting their own preadmission/closing attachment — otherwise durable acknowledgement creates a circular wait. Cost: those hooks must transform the original input or send after admission instead.
Ruling: Keep ES2023 compiler target; use existing Promise constructor pattern instead of Promise.withResolvers.
Ruling: Mixed durable/transient acceptance requires an in-memory message-ID order, not grouping by persistence — failing regression proved reordering; no new public identity.
Ruling: pnpm build is blocked by sandbox spawn EPERM; verify all eight projects by direct node tsc, retain the failed command as evidence.
Ruling (supersedes AsyncLocalStorage): core boundary forbids node imports. Track hook/admission lifecycle locally instead; sends during preadmission or reentrant closing hooks reject explicitly. Immediate sends directly after stream() returns are buffered; externally arriving sends during an admission hook must retry after admission. Cost: this small preadmission window is unavailable; documented in guides/API.
Tasks 2/3: implementation complete; 228 core tests passed, including failed admission, failed storage acknowledgement, mixed persistence ordering, limits and closed completion boundary.
Task 4: public fixture passed directly and against built declarations. Full pnpm test passed320/skipped39; test:integration passed33. Eight direct tsc project builds, typecheck and check:boundaries passed. Guides and API reference updated; reference consistency checker passed. Skipped live storage backends remain unverified.
Final review: dispatched read-only signal_final_review with approved spec/plan, five review focus conditions and ruling caveat.
Final review: two Important findings confirmed, no Critical/Minor findings. Reviewer declined live PostgreSQL/MongoDB and real provider execution; scope ruling: SQLite/runtime semantics verified here, do not claim live server/provider behavior.
Final: fixed transient stream.before cursor leak — never-checkpoints-transient test RED→GREEN; transient decision payload redacted in checkpoint and reconstructed only from retained memory for same-process resume.
Final: fixed handled transient initial input invoking provider — handled-input test RED→GREEN; initial transient input is an applied overlay, not newly pending work. Same-process stream.before interruption/resume check passes.
Ruling: original input hooks still inspect transient input; only automatic durable cursor payload excludes it. Developer-selected plugin output/state can explicitly retain data. Cost: after restart the transient input is unavailable to continuation handlers, consistent with persist:false.
Final: no minor findings deferred. Full-suite rerun after fixes pending below.
Final: review findings fixed in one pass; targeted tests green, post-fix full integration33passed, package326passed39skipped before final plugin-state test; that added concurrency test passed focused and final full package rerun follows.
Final: PostgreSQL storage suite29passed, MongoDB17skipped (no URL). SQLite signal restart verified; no live-provider behavior claim.
Ruling: Keep build verification through direct tsc (all8projects), since pnpm recursive lifecycle spawn is denied in this environment. This changes no project scripts; CI still needs normal pnpm build.
Ruling: Retain the checkout and ignored execution evidence; no branch integration, commits or publication were authorized by this plan.
Task 2: complete — final package suite327passed39skipped; direct/pending/failed-admission/commit and plugin-state concurrency checks pass.
Task 3: complete — parallel tool grouping, same execution continuation, transient positioning, policy/cancel/limits and finalization race checks pass.
Task 4: complete — full integration33passed, real SQLite restart and public built consumers passed; PostgreSQL storage29passed, MongoDB17skipped. All8direct tsc builds, typecheck, boundaries, API reference checker and diff whitespace checks passed.
Final review: two Important findings fixed RED→GREEN, green full suite afterward; no deferred minors. Work left in requested checkout without git/release actions.
