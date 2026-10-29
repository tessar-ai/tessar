# Provider Request Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Separate normalized Agent context from provider-native request mutation.

**Architecture:** Keep context.prepare on the primary Agent loop. Replace the
normalized model.request hook with provider.request, dispatched through an
optional ModelCallContext.prepareRequest callback inside each provider adapter.
Use the existing transformation dispatcher and attempt/error lifecycle.

**Tech Stack:** TypeScript ESM, Vitest, official OpenAI SDK, pnpm.

**Spec:** ../specs/2026-10-26-provider-request-design.md

## Global Constraints

- Node.js >=24.22.1 and pnpm 11.5.3; no new dependency or core Node imports.
- No compatibility layer, alias, dual dispatch or database schema change.
- Do not expand auxiliary context preparation or implement subagent behavior.
- Preserve caller error identity, provider defaults and unrelated dirty docs.
- Work in the supplied checkout; do not commit, publish or edit external projects.

## Review Focus

- Invalid hook output, identity changes or cancellation must cause zero SDK calls.
- Concurrent auxiliary requests must retain their own attempt/model identity.
- SDK retries must reuse the prepared body while new adapter calls rerun hooks.
- Replacing the native body must not bypass protocol safeguards or mutate history.
- Trace input must identify normalized context rather than claim native payload.

## Task 1: Shared provider request hook and execution bridge

**Files:** packages/core/src/models/contract.ts, events/type.ts, index.ts,
engine/provider-request.ts (new), loop.ts, engine/services.ts;
packages/core/test/engine/provider-request.test.ts (new), engine/context.test.ts.

**Interfaces:** Add ProviderRequest with model, protocol, attemptId, purpose and
body. Add optional ModelCallContext.prepareRequest(protocol, body): Promise<JsonObject>.
Add provider.request transformation map/type, remove model.request. The internal
bridge captures attempt identity and delegates to existing execution.hook.

- [x] Write regression tests: native hook chaining/undefined; immutable inputs;
  invalid envelope and protected metadata fail; auxiliary callbacks correlate
  attempts and do not run primary context hooks; independent child Agents run
  their own registered context hooks.
- [x] Run the new tests and observe failures caused by the missing feature.
- [x] Implement contracts, bridge and primary/auxiliary dispatch integration.
  Validate JSON/body and protected metadata after each handler through the shared
  dispatcher; keep protocol validation in adapters.
- [x] Update existing normalized-hook tests to context.prepare.
- [x] Run core provider/context/model-observability tests; require PASS.

## Task 2: OpenAI native request boundaries

**Files:** packages/openai/src/adapter.ts, chat-adapter.ts;
packages/openai/test/provider-request.test.ts (new).

**Interfaces:** Both adapters await prepareRequest after encoding and before SDK
create. Reuse an internal helper for JSON preparation and shared request guards;
Responses and Chat retain their specific runtime constraints.

- [x] Write fetch-backed tests for both protocols: encoded body visible, chained
  body changes sent, unchanged defaults, failure/cancellation before HTTP send,
  model/stream/background/continuation violations rejected, and SDK retry reuses
  a single prepared body. Test later calls rerun preparation.
- [x] Run the new tests and observe expected failures.
- [x] Implement preparation, post-hook protocol safeguards, cancellation check,
  and preservation of Tessar/plugin versus provider error provenance.
- [x] Run provider-request, adapter, chat-completions and continuity tests; require PASS.

## Task 3: Public consumers, documentation and whole-change verification

**Files:** packages/core/test/public-types.test.ts, events/string-events.test.ts,
packages/opentelemetry/src/models.ts and affected tracing tests;
docs/api-review.md, docs/plugin-api-and-events.md, docs/architecture-notes.md,
packages/core/README.md, examples/guide/plugins.md.

**Interfaces:** Export provider map and ProviderRequest through existing public
entrypoints. Mark tracing inputSource as normalized context; do not add a second
final-native-body event or change trace hierarchy.

- [x] Assert public provider.request payload typing and removal of model.request.
- [x] Update built-in tests/fixtures and developer examples directly. Include a
  native-body hook example, auxiliary/subagent distinction and retry semantics.
- [x] Verify with pnpm typecheck, pnpm build, pnpm test --maxWorkers 4,
  pnpm test:integration --maxWorkers 4, and pnpm check:boundaries.
  Require successful exit codes; storage tests remain environment-dependent.
- [x] Review the complete diff for scope and correctness, fix material findings,
  and rerun affected checks. Record actual results; do not publish or commit.
