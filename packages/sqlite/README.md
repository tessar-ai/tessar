# @tessar/sqlite

SQLite persistence for Tessar's state and checkpoint contracts, using Node's
built-in SQLite API. Requires Node 24.22.1 or newer.

```sh
npm install @tessar/core @tessar/sqlite
```

```ts
import { SqliteStoragePlugin } from "@tessar/sqlite";

const storage = new SqliteStoragePlugin({ filename: "./state.db" });
// Include storage in new Controller({ id, agent, plugins: [storage, ...] }).
```

Core owns state/checkpoint behavior; this plugin supplies physical persistence.
Choose the backend before Controller initialization. Scope filters bind queries
to application-selected metadata; applications own authentication and authorization.

Node's SQLite API is experimental. This backend uses synchronous database
operations and is a reference implementation, not a server throughput claim.

This is an early 0.x release. See the
[repository](https://github.com/tessar-ai/tessar) for usage and contracts.

## Schema v1

The current layout is the initial schema, recorded as `PRAGMA user_version=1`.
Initialization creates missing tables and indexes transactionally. Tables and
explicitly named indexes use the `tessar_` prefix.

Messages and trace records have revision intervals instead of one copy per
checkpoint. Public checkpoints still hydrate complete logical history. Successful
publication removes staging; receipt fingerprints continue rejecting a changed
payload with the same commit ID. Session selection writes use transactional CAS.
There is no `agents` table.

History and record pages use bounded SQL queries and indexed parent/date/ID
columns. Arbitrary scalar scope keys are bound JSON predicates and may require
scanning candidates; there is no automatic index per scope key. SQLite uses
synchronous operations, so large writes can still block the Node event loop.

Delete remains soft. Purge is explicit, guarded by ownership and retained fork
lineage, and never removes plugin-owned tables. Plugins needing independent job
claims or scheduling indexes own their database/schema and migrations; the core
state API exposes JSON state, not raw SQL access.

Lease fencing counters survive purge. A stale lease cannot regain ownership when
the same thread ID and owner token are reused. Publication checks ownership again
before committing; an expired lease rolls back the complete publication.

See the [storage guide](../../examples/guide/storage.md) for persistent conversations
and restoring a Session after restart.

Independent JSON records are available through `backend.records.append/get/list`
or `tessar.storage.records` after Controller initialization. They use one
`tessar_records` table and do not require a Session/Thread or become checkpoint
state. Initialization adds the table/index to existing stores without resetting
data. See [independent records](../../examples/guide/storage.md#store-independent-json-records)
for parameters, scope filtering and cursor pagination.
