# Hook Contract Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans, native execution, task by task.

**Goal:** Complete the agreed hook/type/plugin cleanup, streaming UI lifecycle,
model settings and audit consistency fixes in one verified change set.

**Architecture:** Keep the existing dispatcher, loop, checkpoint system and
provider-request boundary. Narrow public hook contracts to actual decisions;
remove redundant notifications and unneeded handle barriers. Stream normalized
part lifecycles through the shared model boundary for primary and auxiliary calls.
Keep draft UI status out of canonical messages, storage and provider requests.

**Tech Stack:** TypeScript ESM, Node >=24.22.1, pnpm11.5.3, Vitest, OpenAI SDK.

**Specs:** 2026-10-26-streaming-lifecycle-design.md; provider-request-design.md;
approved decisions in docs/architecture-notes.md. The user explicitly requested
all agreed work, followed by another whole-repo ponytail-audit.

## Global constraints

- No backend refactor, new dependency, DB schema change or compatibility aliases.
- User plugins choose child Agent/Controller/process; no automatic inheritance.
- Keep meaningful state-operation policy gates and tool.before.
- No tool.call.delta, currentParts array, synthetic reasoning completion at text start.
- Preserve unrelated dirty work and prior provider.request implementation.
- No commit, push or publish; work in the current feat/event checkout.

## Review focus

- A hook must not advertise or silently accept decisions ignored by its caller.
- Invalid resumed decisions must leave interrupts pending.
- Provider-data errors, adapter identity and cancellation agree across execution paths.
- Primary/auxiliary part events share identity and cleanup, without leaking auxiliary UI.
- Notification consolidation preserves Session selection/state visibility and one publication.
- Model settings persist before notification; per-stream overrides never mutate Session settings.

## Tasks

1. [x] Add failing regressions for protocol error provenance, adapter identity,
   auxiliary cancellation, decision typing/runtime validation and invalid resume.
   Implement shared identity validation, provider-data error creation and
   boundary-specific decisions; retain generic ControlDecision only as their union.
2. [x] Remove thread.updated, tools.select, duplicate Session thread mutation
   notifications and unneeded message/stream/handle barriers. Publish one structural
   Thread event after Session updates. Narrow exposed plugin state serialization
   methods. Simplify deferred promises and shared OpenAI protocol guards.
3. [x] Implement text/reasoning start/delta/end and tool.call start/end (no delta),
   stable logical message IDs, shared lifecycle checks, auxiliary observation and
   interrupted cleanup. Update adapters, fixtures, StateView, logger and tracing.
4. [x] Add session.model.info/setEffort and optionsChanged, with provider-owned
   effort mapping. Preserve native options, Session persistence and override scopes.
   Make isIdle account for queued work without adding redundant running state.
5. [x] Update public API reference, event inventory and guides. Run typecheck,
   build, package/integration tests, boundaries and fresh whole-change review.
   Finally rerun ponytail-audit across the repo, report real remaining findings.

## Concrete decisions

Decision results: stream.before and tool.before allow/deny/stop/suspend;
turn.decision allow/continue/deny/stop/suspend; model.select allow/select/suspend;
model.recover deny/retry/suspend. Operation gates retain allow/deny only.
allow keeps automatic/default behavior; continue explicitly forces another Turn.
Suspend definitions must resolve to a decision valid for their boundary.
No built-in decision accepts fail or another boundary's command.

Removed barriers: message.beforeCommit, stream.beforeEnd, session.beforeClose,
thread.beforeShutdown and thread.shutdown. Cleanup uses existing defer/dispose;
final observations use message.committed, stream.end and session.closed.
State-operation before-fork/rename/delete and Session before-change/switch retain
their real policy capability; they are not removed merely to reduce event count.

Model helpers accept caller-owned normalized requests; context.prepare remains
on an Agent loop. Part events carry purpose and attempt correlation. No new
subagent-specific service, nested tool API or transport is introduced.
