# List API review (TD-004)

Status: approved scope implemented; final verification recorded in the debt ledger.

Each collection keeps query behavior appropriate to its data. Shared terminology
applies only where behavior is the same. Returning an array is not itself a defect.
The agreed change is limited to the four Thread execution lists below. Other
collection APIs retain their current behavior; speculative query additions are
not requirements for completing this debt.

## Public API inventory

| API | Current behavior | Decision |
| --- | --- | --- |
| `session.model.list()` | Synchronous immutable array of model IDs, names and profiles | Keep; no new query options. |
| `agent.listTool()` | Readonly array of tools configured on the Agent | Keep; does not enumerate plugin-registered tools. |
| `registry.list(kind)` | Array of arbitrary capability values from the captured registry | Keep; no common searchable/sortable value schema. |
| `controller.listSessions({ scope, limit, cursor })` | Scoped cursor page of stored Sessions for this Agent | Keep. |
| `session.thread.list({ limit, cursor })` | Scoped cursor page; excludes deleted Threads | Keep. |
| `thread.getHistory({ limit, cursor, atCheckpointId })` and Session equivalent | Message sequence pinned to a checkpoint | Keep; no arbitrary message sorting/filtering. |
| `thread.listCheckpoints({ limit, cursor })` | Cursor page of checkpoint metadata | Keep. |
| `thread.listStreams({ status, limit, cursor })` | Streams across this Thread | Add optional status filter. |
| `thread.listTurns({ status, limit, cursor })` | Turns across this Thread | Remove required Stream ID; expose optional status filter. |
| `thread.listModelAttempts({ status, limit, cursor })` | Model attempts across this Thread | Remove required Turn ID; expose optional status filter. |
| `thread.listToolExecutions({ status, limit, cursor })` | Tool executions across this Thread | Remove required Turn ID; expose optional status filter. |
| `thread.listInterrupts({ status, limit, cursor })` | Cursor page with pending/resolved/cancelled status filter | Keep. |
| `storage.records.list({ namespace, scope, limit, cursor })` | Required namespace, optional scope, cursor page of independent JSON | Keep. |
| Vector store `list({ filter, limit, offset })` | Array with source/metadata filters and offset paging | Keep existing RAG contract. |

## Thread execution contract

- All four methods take an optional `ExecutionListOptions` object and return
  `{ items, nextCursor }`. They work without first listing Stream or Turn IDs.
- Options contain only `status`, `limit` and `cursor`. IDs remain on the returned
  records for inspecting relationships; there is no public Turn/Stream filter.
- Status uses each resource's own values (`completed` for successful Streams,
  `succeeded` for successful tool executions). Filtering precedes pagination.
- Default page limit is 50, maximum 200. Existing time/ID ordering, Thread scope
  checks and resource/status-bound cursors remain intact.
- Existing backend query capabilities are reused. No storage schema/migration or
  RAG API changes. Passing the old required-ID argument is rejected; update callers
  to pass no arguments or the options object.

See the [storage guide](../examples/guide/storage.md) for usage and the
[debt ledger](technical-debt.md) for completion evidence and test limitations.
