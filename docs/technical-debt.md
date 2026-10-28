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

## TD-003 — Terminal renderer example

**Status:** open. **Scope:** presentation, independent of TD-002.

The current terminal example can leave repeated snapshot frames in scrollback.
Improve presentation across long output, resizing and repeated runs so old
frames are not mistaken for restored history or additional model executions.

This debt concerns the renderer. A terminal fix does not resolve the missing
self-hosted server or browser application integration.

## TD-004 — Consistent filtering, sorting and pagination for list APIs

**Status:** deferred. **Scope:** public collection APIs for SDK and application consumers.

### Gap

Collection APIs currently offer different query capabilities. For example,
`session.model.list()` returns an in-memory array without query parameters.
Session/Thread and execution-record lists already support cursor/limit paging,
with some resource-specific filters, but there is no shared public contract for
filtering, sort fields, sort direction and pagination across applicable lists.
Consumers implement those behaviors themselves, including model-selection UI.

### Direction

- Review public list APIs for models, tools, Sessions, Threads, checkpoints and
  execution records; document which query capabilities each collection supports.
- Define consistent filter/search, sort/order, paging and result semantics where
  applicable, with clear defaults and supported fields for each resource.
- Preserve existing scope boundaries, paging guarantees and compatibility.
  Ordering must be deterministic when values tie, and pagination must remain
  consistent with its active query and ordering.
- Distinguish in-memory collections from storage-backed queries and capability
  registry enumeration. Do not force a database-style query mechanism onto
  every method merely because it returns a list.
- Support CLI selectors and application/browser consumers without requiring
  each host to reinvent common collection handling. Keep behavior consistent
  across applicable storage backends.

Completion requires public documentation and appropriate coverage of filtering,
ordering, pagination and scope isolation for the affected APIs. Parameter names,
page-versus-cursor choices, return shapes and implementation strategy require a
separate design. Recording this debt does not change current APIs.

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
