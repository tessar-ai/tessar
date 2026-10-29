# SDD ledger — plan: docs/superpowers/plans/2026-10-19-tessar-persistence-plan.md

Execution: native. Spec and plan approved. Preserve dirty checkout; no commits/publication.
Ruling: use this current development checkout as explicitly required by the approved plan; no worktree copy/reset.
Ruling: record progress here directly instead of shell-specific skill scripts; the approved plan forbids commits, so git ranges would not identify task changes.
Pre-flight: Tasks 3/4/6 share schema v2: define final entity DDL with v2 bootstrap, add services in 6/7; migrate only once.
Pre-flight: Tasks 2/6/7/8 share ModelConnectionDescriptor; keep descriptor in models/contract and provider-generated continuity, never native request body.
Pre-flight: Tasks 3/5/9 share storage ports; query implementations and purge must preserve historical checkpoint semantics and scope.
Pre-flight: Task 7 changes createSession to Promise; all consumers, test harnesses and examples must await it.
Task 1: in progress.

Task 1: complete — cross-thread lease RED then GREEN; 7 conformance tests pass.
Task 2: complete — continuity RED then GREEN; all 37 OpenAI tests and typecheck pass.
Task 3: in progress.

Task 3: core implementation GREEN — 100 unchanged messages remain 100 rows across rename; published staging removed; changed commit ID payload still rejected. 18 state/backend tests passed.
Task 4: migration basic and rollback tests GREEN — 22 state/backend tests passed. Extended lineage/trace/concurrency cases remain for final integration checks.
Ruling: migration uses node:crypto SHA-256 synchronously inside the SQLite write transaction; same canonical payload as portable Web Crypto, avoiding an async lock/revalidation gap.
Task 5: in progress.

User steering: remove Agent table/descriptor entirely. Task 6 withdrawn; Session retains agentId as an application-code identity without an agents FK. No AgentService or serialization factory. Continue all other approved work.
Task 5: history/query regression GREEN, 24 state/SQLite tests pass; wider scalar/cursor coverage remains.

Task 7: lifecycle implementation complete; 28 focused lifecycle/operation tests passed, followed by complete package suite.
Ruling: session.created is a Controller-plugin notification after initial commit, not replayed to later handle subscribers or on restoration. Async factory subscribers observe subsequent operations. Avoid timers/replay races; consumers of creation must register a plugin hook.
Task 8: 3 real SQLite reopen integration scenarios pass: Responses, Chat, and suspended tool execution with summary/owned state and incompatible-plugin rejection. Legacy connection/protocol checks pass in provider tests. HTTP is mocked; reopening new connections is not a forced process crash.
Task 9: guarded purge GREEN for both memory and SQLite: live/deleted lineage/scoped/active-owner cases.
Task 10: monotonic timing GREEN (5 cases), including auxiliary calls and incomplete open/legacy segments; doc sample generated from actual suspended SQLite integration fixture.
Ruling: concurrent standalone execution order is unspecified; its test now finds requests by model ID instead of assuming async fingerprint completion order. No runtime ordering change.
Verification: 224/224 package tests passed (51 files); test typecheck, core/sqlite/openai/plugins builds and both example builds passed. Package boundary check passed. Earlier isolated subprocess EPERM was environmental; full package run subsequently passed those tests.
Integration full run: 20 passed, 2 failed. One packed npm-host install blocked by offline cache missing zod; one pre-existing embedded logger script missing event-map import (fixing).

Final review: first reviewer unavailable due model usage limit; fresh fallback reviewer completed read-only review with 16 independent tests passing. Three Important findings, no Critical/Minor findings.
Final: fixed stale Session deletion absorbing another handle revision — stale deletion regression RED to GREEN; concurrent-during-delete and lifecycle checks pass. Controls and continuation check current revision; deletion refresh accepts only its expected update.
Final: fixed missing execution-level binding validation before direct Thread resume — endpoint/protocol tests RED to GREEN. ExecutionPosition persists nonsecret modelConnection; same binding is validated before resume/recovery effects, including before any assistant output exists. Explicit different model binding remains allowed; legacy IDs still require host registration.
Final: fixed fork/purge race — memory/SQLite gated publication tests RED to GREEN. Both publication paths revalidate lineage within atomic publication.
Final: fixed memory historical-record membership parity — foreign checkpoint regression RED to GREEN, both backends return no records for another thread.
Final: Ruling: review declined live provider behavior, production migration performance and npm packaging. Protocol checks use fake HTTP; no provider cache/performance claim. npm packaging verified separately (3 distribution tests passed); real process recovery checked by integration suite.
Ruling: offline packed-host test now packs a copied installed Zod into its temporary fixture, because fresh npm cache cannot fetch the required peer and pnpm hardlinks were omitted on direct re-pack. No dependency/version change or network access.

Final verification (2026-10-19): 233/233 package tests across 51 files; 24/24 integration tests across 7 files, no skips. Integration includes packed CLI/plugin install, real process ownership/crash recovery and SQLite reopen scenarios. Typecheck, package boundary check, all four package builds and both example builds passed. Git diff --check reports no whitespace errors (only existing Windows line-ending warnings).
Tasks 1-5 and 7-10 complete. Task 6 withdrawn. Final review's three Important findings fixed with regressions; no deferred minors. Independent migration connections/owned-state preservation, SQLite Session CAS and indexed query plans additionally verified. No user DB touched; no commit, publish, branch change, dependency/version change or memory update.
Workspace and ledger retained because the approved workflow preserves existing dirty changes and forbids commits. No integration menu required: leaving the current checkout intact was already selected.
