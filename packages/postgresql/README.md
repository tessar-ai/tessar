# @tessar/postgresql

PostgreSQL storage for Tessar checkpoints, execution records, sessions, and
plugin-owned state. Uses the native `pg` driver and database transactions.

```ts
import { PostgresqlStoragePlugin } from "@tessar/postgresql";

const storage = new PostgresqlStoragePlugin({
  connectionString: process.env.DATABASE_URL!,
  schema: "tessar", // default
  driverOptions: { max: 10 },
});
// Add storage to your Tessar plugins alongside model and application plugins.
```

`createPostgresqlBackend(options)` creates the same backend directly. Each
backend owns its connection pool; call `close()` when done. Plugin setup registers
the backend with Tessar, which owns its disposal. `driverOptions` accepts native
`pg` pool options, including TLS configuration. `connectionString` is always the
top-level option. Initialization failure closes the pool.

The configured role needs permission to create the schema, tables, and indexes,
and to read and write them. Schema names must match `[a-zA-Z_][a-zA-Z0-9_]{0,62}`.
Use a separate schema per application or environment. Existing application tables
outside that schema are untouched. All backend instances for the same store must
use the same database and schema.

Publication is transactional and uses resource-scoped PostgreSQL advisory locks
to coordinate processes. Lease expiry uses PostgreSQL time; fencing tokens survive
release and thread purge. Message and execution changes use indexed revision
intervals, so unchanged history is not copied into each checkpoint. Reads that
hydrate multiple rows share a repeatable-read snapshot.

Run the repository's `pnpm test:storage` with `TESSAR_TEST_POSTGRES_URL` in the
environment or ignored `.env.storage`. Tests create unique `tessar_test_*` schemas
and remove only those schemas. Database tests explicitly skip without the URL;
they require a real PostgreSQL server and schema creation privileges.

Tables and indexes use the `tessar_` prefix inside the configured schema, for
example `tessar_threads` and `tessar_sessions`.

The physical schema is versioned in `tessar_schema_metadata` (version 1). Initialization
is serialized by an advisory lock. Existing unversioned `tessar_*` tables
are adopted without resetting data; unsupported versions fail before
application-table DDL. Each backend versions its own physical layout independently
of the Tessar state contracts and npm package versions.

Source responsibilities match the SQLite adapter: `schema.ts` initializes the
layout, `ownership.ts` manages leases, `versions.ts` stores historical records,
`queries.ts` implements paging, and `backend.ts` wires the storage contract.

Use `backend.records.append/get/list` for independent JSON entries, or
`tessar.storage.records` in a plugin after Controller initialization. One
`tessar_records` table in the configured schema stores these entries separately
from checkpoints. Initialization adds the table/indexes to existing stores.
See [independent records](../../examples/guide/storage.md#store-independent-json-records)
for parameters, scope filtering, duplicate identity behavior and pagination.
Record data has the same native JSONB limits as other stored state; PostgreSQL
rejects U+0000 and invalid Unicode surrogate strings, preserving its driver error.
