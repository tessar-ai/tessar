# @tessar/mongodb

MongoDB storage for Tessar using the native `mongodb` driver. Requires a replica
set or sharded MongoDB deployment supporting transactions; standalone servers are
rejected during setup. Repository CI is configured to test a MongoDB 8 replica set.

```ts
import { MongoDBStoragePlugin } from "@tessar/mongodb";

const storage = new MongoDBStoragePlugin({
  uri: process.env.MONGODB_URL!,
  databaseName: "my_agent",
  clientOptions: { maxPoolSize: 10 },
});
// Include storage in your Tessar plugins configuration.
```

`createMongoDBBackend(options)` exposes the same backend directly. The plugin
registers it with `tessar.storage.register`; the backend owns its MongoClient and
its idempotent `close()` closes that client. Initialization failures close it too.
Use `clientOptions` for native TLS and connection-pool configuration.

The database contains `tessar_*` collections for sessions, plugin state, thread
heads, checkpoints, version intervals, staging and commit receipts. Messages and
execution records are versioned individually; unchanged messages are not copied
into each checkpoint. Staging uses separate message and record documents, so a
conversation can exceed MongoDB's 16 MiB document limit. Each individual message,
record, checkpoint metadata or plugin state must still fit that native limit.
Large commits are also subject to MongoDB transaction resource/time limits.

Publication uses snapshot transactions and majority acknowledgement. Lease
expiry uses server time. Lease documents retain monotonic fencing tokens after
release and purge. Thread coordination writes serialize publication, takeover,
session selection, fork-source validation and purge across clients.

Set `TESSAR_TEST_MONGODB_URL` in the repository's ignored `.env.storage`, then run
`pnpm test:storage`. Tests skip explicitly without a URL. Each test creates and
drops only its generated `tessar_test_<uuid>` database. The database user needs
collection/index creation and database deletion privileges; the rollback test
also uses `collMod` on its generated collection. Never put credentials in tracked
files. No external Docker setup is required when using an existing replica set.

The physical schema is versioned in `tessar_schema` (version 1). Unsupported
versions fail before creating application collections or indexes. Initial
unversioned data is retained. Metadata is stamped only after initialization
finishes, so an interrupted initial setup can be retried without a reset.

The adapter separates `schema.ts`, `ownership.ts`, `versions.ts`, `queries.ts`,
connection/transaction lifecycle in `database.ts`, and contract wiring in
`backend.ts`. It follows the same logical storage rules as SQLite/PostgreSQL;
native collections and transactions implement those rules.

Use `backend.records.append/get/list` for independent JSON entries, or
`tessar.storage.records` in a plugin after Controller initialization. One
`tessar_records` collection stores entries separately from conversation versions
and checkpoints; initialization adds it and its indexes to existing databases.
Each append is an atomic document insert. See
[independent records](../../examples/guide/storage.md#store-independent-json-records)
for parameters, scope filtering, duplicate identity behavior and pagination.
