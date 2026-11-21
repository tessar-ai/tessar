# Core commit preparation implementation plan

**Goal:** Reduce validation allocations and repeated history copying without
changing commit counts, fingerprint bytes, public APIs or recovery boundaries.
**Architecture:** Shared content validation plus a read-only message fast path
for proven JSON snapshots. Own/freeze frame state once and share immutable state
through checkpoint transitions; retain the existing clone fallback for graphs
that cannot be proven JSON. Execution position remains mutable and keeps identity.
**Spec:** [commit-pipeline.md](commit-pipeline.md).

## Constraints and review focus

- Work in the current checkout, preserving all existing uncommitted changes.
- No dependency, version, backend implementation, dirty tracker or Rust changes.
- Preserve string-content normalization, extra-array-property clone errors,
  malformed messages, duplicate IDs and tool correlation.
- Preserve retained-storage isolation and mutable execution position.
- Preserve retries, lost publish receipts, parallel tools, signals and recovery.

## Steps

- [x] Capture the current built core and execution benchmark baseline in ignored results.
- [x] Add failing tests: proven batch validation needs no content clones; malformed
  frozen data still fails, raw/unusual inputs keep decode behavior.
- [x] Extract internal `validateContent()` from `normalizeContent()` and add
  internal `validateMessage()` in codec; `validateBatch()` uses it. Keep public
  MessageCodec signatures and constructor copy behavior.
- [x] Add failing execution tests: successive committed states share unchanged
  immutable history, new message arrays leave old states intact, retained backend
  references cannot alter current state; unusual JSON graphs keep clone isolation.
- [x] Freeze owned frame state at creation and checkpoint construction. Reuse
  proven state after publish; retain deep-copy fallback. Preserve execution refs.
- [x] Remove only TurnBoundary's redundant usage refresh. Keep finish() usage.
- [x] Run focused tests, typecheck, build, package tests, boundaries and integration.
- [x] Run the same commit counters and execution benchmark; compare outputs,
  model/tool/commit counts, CPU/work counters and unprofiled elapsed samples.
- [x] Request one independent read-only review, address findings, update report.

No commits or publication are part of this task. Record any material deviation here.

Ruling: Deep-copy execution position into the submitted checkpoint before publish,
then retain the working execution reference. The retained-checkpoint test showed
budgets/timing changing after staging with the old shallow execution snapshot.
This keeps isolation while removing whole-history clones after publication.

Verified: typecheck, workspace build, boundaries; 1,099 package tests passed,
77 conditional skips; all 89 integration tests passed. Public runtime exports
match the saved baseline. Independent scoped review found no concrete issues.
Execution benchmark: three process pairs, 15 samples per variant/case, all model,
tool, handler, commit and render-snapshot counts unchanged. See commit-pipeline.md.
