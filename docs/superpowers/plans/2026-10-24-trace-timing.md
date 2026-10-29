# Trace Timing Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Do not delegate.

**Goal:** Correct Turn and tool durations before extending trace coverage.

**Architecture:** Retain the Turn's original start timestamp in plugin memory.
Expose the already-recorded tool completion timestamp on the existing `tool.end`
notification and use it when closing a tool span that started in this segment.
The user selected a separate Agent-rooted trace per invocation, grouped by
Thread in Langfuse Sessions. Resume/recovery opens a new trace segment keyed by
the checkpoint, retaining logical Stream/Turn IDs and persisted Turn counters.

**Tech Stack:** TypeScript ESM, existing OpenTelemetry SDK, Vitest.

**Spec:** [Trace timing corrections](../specs/2026-10-24-trace-timing.md).

## Global Constraints

- Node.js >=24.22.1; pnpm 11.5.3; no new dependencies.
- Keep tool execution, concurrency, result ordering and persistence behavior unchanged.
- Preserve Langfuse display mappings, persisted identifiers and public hook names.
- Do not commit, publish or bump versions.

## Review Focus

- Session follow-ups retain global Turn numbering while including preparation time.
- Fast tools do not inherit a slow sibling's duration.
- Tool failures retain the physical completion timestamp.
- Recovered results without a fresh start never create negative durations.
- Suspension/resume retains existing correlation and immutable span behavior.

## Task 1: Session Turn timestamps

**Files:** `packages/opentelemetry/src/{types,lifecycle,trace}.ts`,
`packages/opentelemetry/test/index.test.ts`.

- [x] Add a regression with delayed context preparation and capture `turn.start`.
- [x] Verify it fails because the Session Turn starts at `model.start`.
- [x] Retain the current Turn's start timestamp and use it when materializing its span.
- [x] Run the tracing tests and typecheck.

## Task 2: Tool completion timestamps

**Files:** `packages/core/src/events/type.ts`,
`packages/core/src/engine/tool-executor.ts`,
`packages/opentelemetry/src/tools.ts`, relevant tests and developer guides.

- [x] Add a regression comparing parallel tool spans with stored completion timestamps.
- [x] Verify it fails before adding optional `tool.end.endedAt`.
- [x] Include the existing record timestamp in that notification; retain notification order.
- [x] Use the recorded timestamp only for a tool span that started in this segment.
- [x] Verify failed tools, suspend/resume, and cached notifications without a fresh start remain valid.
- [x] Update the event documentation; run package tests, typecheck and boundaries.

## Task 3: Trace-per-invocation hierarchy

- [x] User selected option 2: a new trace for each new invocation, grouped in Langfuse Sessions.
- [x] Update the spec with the approved direction before changing root behavior.
- [x] Finalize resume/recovery segments and immutable root identities.
- [x] Write hierarchy regressions and observe failures for follow-up, switch, restart and resume.
- [x] Create fresh recording roots/Turns for each invocation or continuation; retain Thread counters.
- [x] Cover saved tool publication before stream.resumed and direct Agent resume without a Session.
- [x] Verify full package/integration suites and built consumer (388 package tests, 43 integration tests).
- [ ] Verify actual Langfuse grouping through Cloud API; not run during the requested consistency audit.

## Follow-up coverage found during review

`prepareRecovery()` can publish a previously committed tool result before
`stream.resumed`. A newly initialized tracing plugin has not opened its execution
state at that point and can miss that notification. The lifecycle handler now
opens the recovery segment from its first checkpoint notification; a restart
regression verifies tool input/output and no repeated execution. Core recovery
event ordering remains unchanged.

## Task 4: Optional immediate export

- [x] User approved `OpenTelemetryOptions.realtime?: boolean`, default `false`.
- [x] Observe a regression failure: `true` did not export a completed model while a tool remained active.
- [x] Select native SimpleSpanProcessor for `true`; retain BatchSpanProcessor otherwise.
- [x] Verify omitted/false/true modes with multiple adapters and no unfinished or duplicate spans.
- [x] Verify real local OTLP HTTP success/failure and exporter setup cleanup in both modes.
- [x] Update README, developer guide, API reference and built consumer example.
- [x] Pass 29 tracing tests, 4 built public-import tests, typecheck, build and boundaries.

## Task 5: Framework-wide timing contract and consistency audit

- [x] User requested consistent record timestamps across Stream, Turn, model and tool events.
- [x] Add regressions and observe missing timestamp failures, including auxiliary failures.
- [x] Publish record timestamps without changing event ordering; focused tests pass.
- [ ] Update tracing consumers and timing docs together, retaining resume segment boundaries.
- [x] User requested a whole-codebase consistency review before further fixes.
- [x] Record nine findings, executable probes and verification in docs/consistency-audit.md.

The audit is complete; timing consumer work remains incomplete (C04). Do not
describe all timing changes as finished merely because tests pass.
