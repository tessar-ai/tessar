# SDD ledger — plan: docs/superpowers/plans/2026-10-26-provider-request.md

Spec: docs/superpowers/specs/2026-10-26-provider-request-design.md
Execution: native, user authorized implementation in current checkout.
Pre-flight: task 1 produces ModelCallContext.prepareRequest and provider.request;
task 2 consumes both; task 3 updates public consumers. No interface conflict.
Ruling: work on existing feat/event checkout, preserve unrelated dirty docs;
the environment exposes .git read-only, so no worktree/commits are attempted.
Ruling: context.prepare remains primary-only; auxiliary requests are caller-owned.
Subagents use separate Agents/Controllers selected by plugin, with no inheritance.

Task 1: in progress — write regression tests before implementation.
Task 1: RED observed: 10 missing-hook failures, 1 independent-context regression passed.
Ruling: keep request validation in models/provider-request.ts and execution binding
in engine/provider-request.ts; dispatcher validates/freezes each replacement.
Ruling: generate preserves the existing contract: plugin/Tessar failures return
failed outcomes; provider failures throw. Test provenance without changing it.
Task 1: complete — focused combined run: 61 tests PASS across 7 files.
Task 2: RED observed: 20 missing-preparation failures, 2 no-hook baselines passed.
Task 2: complete — focused combined run: 61 tests PASS; HTTP bodies, cancellation,
identity/protocol guards and SDK retry reuse covered for both protocols.
Ruling: allow native provider routing field in body (e.g. OpenRouter); it is not
the SDK client's provider option. Other client-only fields remain rejected.
Task 3: in progress — public types, built-in consumers, docs and full validation.
Ruling: leave ScriptedProvider as a normalized fake; new NativeFixture exercises
the callback instead of inventing an SDK wire format for that provider.
Ruling: dispatcher owns immutable snapshots, so avoid duplicate serialization in
the bridge. OpenAI adapters normalize omitted SDK fields before dispatch.
Verification: typecheck PASS; boundaries PASS; build PASS.
Package suite: initial npm fixture timeout (25s); isolated rerun4/4 PASS;
full rerun440 PASS,39 skipped. Integration43 PASS across9 files.
Fresh independent review: no critical/important findings; no code changes requested.
Final rebuilt checkout: typecheck PASS, boundaries PASS, build PASS,
integration43/43 PASS. Full source package rerun440 PASS,39 skipped.
Task 3: complete — docs and public contracts updated, no compatibility layer.
Disposition: changes remain in the supplied feat/event checkout; no commit/publish.
