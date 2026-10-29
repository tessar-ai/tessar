# SDD ledger — plan: docs/superpowers/plans/2026-10-24-consistency-fixes.md

Authorized: fix C01–C09 and complete Langfuse. Current checkout is explicitly
authorized and dirty; preserve unrelated changes, no commits/publish. Inline
execution; one final independent review as required by executing-plans.

Task 1: complete. RED plugin schema-change resume and Tool alias regressions;
GREEN shared schema identity, per-Agent alias bindings via cloned Tool definition.
Updated an old test that incorrectly rejected valid distinct aliases.

Task 2: complete and broadly validated. RED native OpenAI connection B succeeds
directly but fails through Session. Retain executable named connections inside the
existing registry, Thread admissions carry the chosen adapter, continuations resolve
their checkpoint model, and same-runtime getSession restores it. New model selection
still enforces opaque-history compatibility; test changes Thread before changing model.
Registered factories without withModel remain supported. No new public registry API.

Task 3: complete and broadly validated. RED registered storage port provenance;
GREEN internal guardStorage at registration/default/standalone boundaries. Preserve raw
errors, respect existing origins and TessarError classification. Every storage port
and close are guarded, custom registered backends included. No public helper export.

Task 4: complete and broadly validated. RED missing/unequal notification times
and absent error hooks. Stamp once at PluginHost/delivery boundaries and EventEnvelope
fallback. Runtime errors dispatch to captured hooks before sink. Consumer overflow
also publishes to hooks with target=consumer; it still detaches delivery only.
Tracing ignores consumer-only errors. Event timestamp now required on actual envelopes.

Task 5: complete and broadly validated. RED parent closes but child remains live;
GREEN Controller closes Session handles/queues before plugin shutdown. Preserve public
before-close barrier refusal/retry; forced parent teardown reports barrier errors
and still cleans the handle. Await session.closed dispatch before disposing plugins.

Task 6: complete. RED plugin-created adapter lacked native protocol/options;
GREEN both native protocols use OpenAIProvider and a shared lazy connection. Metadata
still returns original provider patches. 44 OpenAI tests and typecheck pass.
Ruling: plugin default connection IDs follow native provider UUID behavior; explicit
stable connectionId is required for process restart, same as direct providers.

Task 7: complete, including Cloud validation. RED delayed-commit root/Turn/model/tool
lifetimes, GREEN shared start/end timing with segment clamps. Completed observations
retain record times as metadata. Recovered cached results remain instantaneous and
resumed children never precede their new root. Tracing regression suites pass.

Task 8: complete. Updated API declarations/reference, OpenAI README, architecture
authority notes and tool/Stream/Session/tracing guides; audit preserves its initial
snapshot and now includes the C01-C09 resolution matrix and verification limits.

Independent review fixes (each RED then GREEN): retained connection removal and
descriptor collision; frozen storage port support; no phantom Turn for post-turn
auxiliary calls; captured registry lease through asynchronous consumer-error hooks;
provider-specific options left to providers on both Agent and Session paths; backend
cleanup close now uses its storage provenance boundary. Reviewer rechecked all
final changes: no remaining important correctness issue, typecheck and 9 focused
tests passed independently.

Broad verification caught obsolete backend/function identity assertions (updated
to verify registration and original driver close exactly once), a default generic
becoming never for Agent<ModelRef> options (fixed with public type regression), and
prepack rewriting shared dist during process tests (integration pack now consumes
prebuilt artifacts with pnpm --config.ignore-scripts=true). Original signal-write
failure injection remains exercised through its registered raw backend.

Final parent verification on Node 24.22.1 / Windows: workspace build, source/test
typecheck, dependency boundaries and git diff --check passed. 405 package tests
passed, 39 skipped; all 43 integration tests passed. No real PostgreSQL/MongoDB
servers were exercised; skipped tests do not establish backend verification.

Latest Langfuse Cloud API check used scripted models/tools and the final build:
Thread consistency-17a01646-1308-4207-a16f-177e786e76b7; two fresh traces
a1c7887c08ca0f19b7141cdef6b0966a / a2ff61951a732e3524e9a9c25ee3e589;
9 and 3 observations, all grouped by Thread, System input/model output and tool
description/schema present. HTTP retrieval and exporter receipts succeeded;
generation visible while weather tool still blocked, before root completion.
Artifact: .superpowers/cloud-test/consistency-result.json. No dashboard browser
inspection, real provider generation, package publication or Git changes performed.
