# SDD ledger — plan: docs/superpowers/plans/2026-10-15-tesseract-implementation-plan.md

Method: Native; A1–A6 → B1–B5 → C1–C6. No per-task subagents; fresh final review.
Ruling: Fresh repo initialized on feat/tesseract-framework in place — no existing branch/source to isolate, workspace is user-selected D:/Tesseract — cost if wrong: no separate worktree copy.
Ruling: Use PowerShell/Node equivalent task briefs/ledger commands — Bash helpers unavailable and plan labels are A1/B1/C1, not numeric — cost if wrong: manual bookkeeping must retain base/test evidence.
Pre-flight: A1→A2→A3 JSON/events/model types: staged additions, no forward imports.
Pre-flight: A3→A4 trace/checkpoint records: use state spec field names, null/coverage retained.
Pre-flight: A4→A5→A6 immutable publication/ownership: both backends implement same ports and conformance.
Pre-flight: A2/A4/A5→B1 hooks/storage/context: one loop and required writes.
Pre-flight: B1→B2→B3 resume/recovery: same streamId, new attachment, no replay of unknown effects.
Pre-flight: B1/B2→B4/B5 delivery/registry/effects: no unused iterator and stable manifests.
Pre-flight: A3→C1/C2 metadata/provider: isolated SDK, exact identity, no network getter.
Pre-flight: B→C3→C4 runtime/session: public integration subpath, no core dependency on SDK.
Pre-flight: B5/C3/C4→C5/C6 plugin proofs: public imports, tracked dispatch; no feature policy in engine.
Task A1: in_progress; RED pending; no production code written.
Task A1: complete; tests pnpm test →6/6; pnpm typecheck PASS; pnpm build PASS. RED missing modules then invalid wire ID reproduction; GREEN validated.
Ruling: Vitest uses --configLoader native --pool threads — default Vite bundled config starts a blocked Windows child process; native Node24 loading runs correctly — cost if wrong: CLI commands must use these flags; CI uses same path.
Task A2: in_progress; brief core-storage-plan Task A2 read; foundation events first, domain registrations staged later.
Task A2: complete; RED missing definitions/host; pnpm test →11/11; typecheck/build PASS. Tests cover typed custom hooks, denial precedence, rollback, captured registrations, deferred disposal and observer failures.
Task A3: in_progress; models/tools/usage contracts next; no vendor dependency in core.
Task A3: complete; RED missing tool/usage/provider; pnpm test →15/15, typecheck/build PASS.
Ruling: Complete domain event catalog with B1 actual boundary payloads rather than speculative A3 declarations — avoids loosely typed unused hooks — cost if wrong: B1 must verify catalog coverage before completion.
Task A4: in_progress; commit staging/publication, lease fencing and history snapshots share backend ports.
Task A4: complete; RED missing backend/commit; pnpm test →19/19; typecheck/build PASS. Hidden staging, immutable revision, idempotent commitId, stale fencing and lost-ack lookup verified.
Task A5: in_progress; scope/history/plugin-state/fork with shared ThreadService mutation helpers (no app-level Store).
Task A5: complete; RED missing queries/fork/state then wrong creation ordering and missing owner-state CAS; pnpm test →26/26; typecheck/build PASS.
Ruling: Added ThreadService mutation helper and backend ownedState CAS — keeps generic thread operations reusable and agent/session plugin data outside fork checkpoints — cost if wrong: extra backend port to implement/test.
Task A6: in_progress. Node spawnSync(process.execPath,[--version]) gives EPERM in sandbox; worker isolates and separately launched tool processes will be labelled distinctly. No escalation requested.
Task A6: complete; RED missing backend and process fixture; pnpm test →29/29; integration →1/1 actual OS-process race; typecheck/build PASS.
Ruling: Process support probed inside Vitest; actual subprocess test succeeded there despite outer Node probe EPERM — retain explicit conditional skip only for truly unsupported runners, no local skipped tests — cost if wrong: CI must report skip count.
Gate A: PASS storage/contracts tests; no agent runtime claimed yet.
Task B1: in_progress; read durable-engine Task B1/spec boundaries; implement same engine behind later SDK.
Task B1: complete; RED missing engine/harness, then hard-limit double finalization and uncommitted finalizer failure reproduced; pnpm test →34/34; integration1/1; typecheck/build PASS.
Ruling: Thread lifecycle notifications are wired at SDK Thread façade in C3, while B1 owns execution boundaries — core engine has no SDK Thread dependency — cost if wrong: C3 must cover ThreadPrepare/Started/BeforeShutdown/Shutdown explicitly.
Task B2: in_progress; generic interruption with persisted handler cursor and atomic response publication, no JavaScript stack serialization.
Task B2: complete; RED missing interruption, then duplicate response OwnerActive reproduced; pnpm test →40/40; typecheck/build PASS; OS-process integration1/1 PASS (repeated after fixing SQLite initialization PRAGMA order).
B2 covers five allowed decision boundaries, invalid response retained, cursor skips old handlers, duplicate same-runtime responses consumed once, explicit model override preserves old attempt identity.
Task B3: in_progress; recovery requires positive evidence/reconciliation for unknown effects.
Task B3: complete; RED missing recovery then retry callId bug and process-crash observer missing from manifest reproduced; pnpm test →44/44; actual process integration3/3; typecheck/build PASS.
B3 actual-process cases: exit after model-result commit reused result; exit after tool dispatch stayed interrupted/RecoveryRequired with one side effect. Test-only DB lease expiry simulates elapsed TTL after process exit.
Ruling: Durable cancellation cleanup completed with B4 delivery/cancellation task — keeps abort and attachment semantics together — cost if wrong: B4 must include dormant/pending-interrupt and unknown-tool cancellation tests.
Task B4: in_progress; bounded stream delivery, abort/observer cleanup and durable cancellation.
Task B4: complete; RED missing delivery and failed suspended/abort-ignoring tool cancellation; pnpm test →49/49; integration3/3; typecheck/build PASS. 512-event/4MiB limits detach only, observer-only path has no iterator queue, late emissions ignored, dormant interrupt cancellation durable, unknown in-flight tool remains interrupted.
Task B5: in_progress; auxiliary calls/effects/child reservations and stable plugin generations. Keep orchestration strategy outside core.
Task B5: complete; RED missing tracked APIs, changed plugin config, event capability leak, duplicate-child lease leak and owned-state access; pnpm test →58/58; integration3/3; typecheck/build PASS.
Ruling: Agent/session-owned plugin state uses explicit owned().read/update CAS transactions, outside Thread snapshots — preserves lifetime and avoids claiming cross-owner atomic commits; arbitrary hook I/O still requires tracked effects for safe replay — cost if wrong: plugin authors must choose the correct state owner/transaction boundary.
Gate B: PASS scripted engine, fault injection and real process boundaries. No OpenAI/SDK façade claimed yet.
Task C1: in_progress; exact metadata identities, immutable getter, cached/bundled fallback and provenance.
Known follow-up review targets: frame commit notification reentrancy must not allow state.commit deadlocks; dispatcher continuation order must follow saved manifest; validate required limits per call; finalize interrupted turn statuses; auxiliary model lifecycle/abort cleanup; origin admission must release leases on rejection (covered).
Ruling: Root typecheck uses one strict source program (including tests/public type assertions), package build verifies isolated exports — pnpm recursive noEmit consumed stale dependency .d.ts before first build — cost if wrong: package isolation errors surface at build rather than the root noEmit stage.
Task C1: complete; pnpm test 64/64, actual process integration3/3, typecheck/build PASS. Catalog SHA/provenance/tier preservation, exact aliases, account partitions, TTL and conservative inherited-field freshness verified.
Ruling: Commit actions now unavailable because current filesystem policy makes .git read-only (index.lock Permission denied) — continue authorized workspace edits and verification without bypass — cost if wrong: C1 and remaining changes need local commits after permissions allow.
Task C2: in_progress; reference OpenAI Responses adapter, official SDK custom-fetch SSE tests.
Task C2: complete; RED absent adapter/codec/plugin; unit72/72, typecheck/build PASS. Official SDK mocked HTTP/SSE verifies reasoning continuity, two fragmented function calls, cumulative token/cache usage, incomplete/missing usage, HTTP429 single request, abort and exact custom-endpoint metadata policy. No live API calls made.
Task C3: in_progress; Agent RuntimePort delegation, Controller lifecycle and scoped low-level Threads.
User-approved architecture correction: ponytail applies retroactively; event names are strings with constants/type map. Agent, Controller, Session, Thread and public SDK APIs belong directly in @tesseract/core. No separate @tesseract/sdk runtime, RuntimePort, bindRuntime or /runtime integration export. Notes, public spec and A/C/master plans updated; source migration/event refactor not yet implemented. C3 remains in_progress; previous test evidence describes previous implementation only.
Plan correction verified: all active plans now specify Agent owns loop directly; removed legacy engine class/options, engine/engine implementation paths and harness.engine example calls. rg AgentEngine|EngineOptions|engine/engine|{engine, returns no matches across docs/superpowers/plans. Source migration remains pending.
