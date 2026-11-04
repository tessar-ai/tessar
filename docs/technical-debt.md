# Technical debt

Tessar targets both CLI agents and agents embedded in applications. This ledger
records missing capabilities and future direction, not implementation designs.
A working terminal example does not establish browser application support.

## TD-002 — Self-hosted server and application/browser client SDK

**Status:** deferred. **Scope:** future application integration work.

### Gap

The current SDK provides an agent runtime and in-process state updates. It does
not provide a complete self-hosted HTTP server and browser client SDK. Application
developers still have to build the connection between backend execution and the
browser themselves. This debt extends beyond rendering snapshots.

### Direction

- Support independent self-hosting with a server that exposes HTTP APIs for
  interacting with the runtime.
- Provide a browser client SDK for interacting with that server and receiving
  accumulated state in real time.
- Cover the complete application flow: conversations, history, thread/model
  selection, incremental text/reasoning, tool activity, user input/approval and
  continued interaction across multiple turns.
- Address reload, reconnection, recovery and multiple users/tabs without
  confusing conversation identity or execution state.
- Preserve integration into a developer's existing backend, alongside the
  independent self-hosting case.
- Let applications choose their UI and presentation. Browser consumers should
  not need to reconstruct conversation state from individual model/tool events.

Completion requires a working server-to-browser application flow, including
continued interaction after reload or disconnection. CLI-only demonstrations
are insufficient evidence for closing this debt.

Class names, constructors, endpoint schemas, transport protocols, package layout
and implementation strategy remain undecided and require a separate design.

## TD-004 ? Collection query capabilities and Thread execution lists

**Status:** completed for the agreed scope (2026-11-04).

The collection review established that each API needs only capabilities appropriate
for its data. Model/Tool arrays, capability enumeration, Session/Thread paging,
checkpoint/history queries, independent records and vector listing retain their
existing behavior. No universal search/filter/sort/paging contract is required.

The concrete gap was Thread execution inspection: callers had to discover Stream
or Turn IDs before listing related records, and most public wrappers did not
expose the backend's existing status filter.

### Delivered

- `thread.listStreams()`, `listTurns()`, `listModelAttempts()` and
  `listToolExecutions()` list all matching records in the current Thread.
- All four accept optional `{ status, limit, cursor }`, exported as
  `ExecutionListOptions`, and return the existing `{ items, nextCursor }`.
- Stream/Turn relationships remain on returned records. Old required-ID arguments
  are removed without overloads and rejected at runtime. Callers and guides are
  updated; no persistence migration or new backend query implementation is needed.
- Existing Thread scope, deterministic ordering, status-before-paging and
  resource/status-bound cursor checks are preserved.

### Verification

Shared regression coverage verifies multiple Streams/Turns, status filtering,
pagination, cursor binding and Thread/scope isolation on Memory and libSQL.
Core/backend checks: 352 passed, 55 skipped. Affected process/persistence integration
checks: 15 passed. Source/test typecheck, workspace build and dependency boundaries
passed. Live PostgreSQL/MongoDB checks were skipped because no test URLs were
configured; the shared regression runs for those backends when configured.

See the [final API inventory](list-api-review.md) and
[storage guide](../examples/guide/storage.md). Additional query capabilities require
a concrete use case and separate design; they are not outstanding TD-004 work.

## TD-005 — Local IPC and synchronized CLI tabs

**Status:** deferred. **Scope:** optional communication between CLI processes,
independent of the HTTP server/browser client SDK in TD-002.

### Gap

Tessar already supports building and packaging CLI applications. Stream events
and Session subscriptions currently stay within their process. Two CLI tabs
using the same persistent backend do not automatically share live rendering.
Thread ownership protects execution and writes; it does not broadcast UI state.

### Direction

- Support local communication between CLI processes so tabs viewing the same
  conversation can display the same text/reasoning, tool activity and status.
- Allow input from either tab while preserving one active execution per Thread
  and existing input/queue semantics.
- Provide an initial state snapshot and ordered live updates, including when
  another tab joins during streaming or reconnects after disconnection.
- Preserve workspace, conversation and scope boundaries. Sharing a working
  directory alone must not mix unrelated conversations.
- Define connection and runtime lifecycle behavior so disconnecting a viewing
  tab does not inadvertently cancel work used by another tab.
- Keep this optional and outside the minimal execution core. Ordinary CLI use
  must continue to work without an IPC host or HTTP server.

Completion requires two real CLI processes showing synchronized state for the
same conversation without duplicate model/tool execution. Process ownership and
startup, transport, APIs and packaging remain undecided and require a separate
design. A Controller plugin alone does not establish a shared runtime.

## Boundaries

Preserve the minimal core and the "anything are plugin" direction. Server,
client, local IPC and presentation capabilities should be optional additions.
Applications retain control of their backend integration, identity/access policy,
deployment and UI choices.
