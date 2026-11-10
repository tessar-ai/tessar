# @tessar/postgresql

PostgreSQL storage for Tessar checkpoints, execution records, sessions, and
plugin-owned state. Uses the native `pg` driver and database transactions.

```sh
npm install @tessar/core @tessar/postgresql pg
npm install --save-dev @types/pg
```

```ts
import { Pool } from "pg";
import { PostgresqlStoragePlugin } from "@tessar/postgresql";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  max: 10,
});
const storage = new PostgresqlStoragePlugin({
  pool,
  schema: "tessar", // default
});
// Add storage to your Tessar plugins alongside model and application plugins.
// After disposing Tessar and any other users of this pool:
await pool.end();
```

`createPostgresqlBackend({ pool, schema })` creates the same backend directly.
Your application owns the pool and must call `pool.end()` after all users finish.
Backend `close()`, plugin disposal, and initialization failure leave it open.
Transactions release their borrowed clients on success and failure. Configure
connection strings, TLS, and other native driver settings when creating the pool.
`pg` and its TypeScript declarations are optional peers installed by your application.

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

Source responsibilities match the libSQL and MongoDB adapters: `database.ts`
provides the borrowed connection, `transaction.ts` owns native transaction lifecycle,
and `schema.ts` initializes state storage when called by the backend factory.
State and vector stores reuse connection/transaction helpers. `ownership.ts` manages
leases, `versions.ts` stores history, `queries.ts` implements paging, and `backend.ts`
wires the storage contract.

Use `backend.records.append/get/list` for independent JSON entries, or
`tessar.storage.records` in a plugin after Controller initialization. One
`tessar_records` table in the configured schema stores these entries separately
from checkpoints. Initialization adds the table/indexes to existing stores.
See [independent records](../../../examples/guide/storage.md#store-independent-json-records)
for parameters, scope filtering, duplicate identity behavior and pagination.
Record data has the same native JSONB limits as other stored state; PostgreSQL
rejects U+0000 and invalid Unicode surrogate strings, preserving its driver error.

## Independent vector storage

`PostgresqlVectorStore` is available from `@tessar/postgresql/vector` independently
of checkpoint storage, Agent, Controller and Session. Install the optional RAG
peer explicitly; the package root remains usable without RAG:

```sh
npm install @tessar/core @tessar/postgresql @tessar/rag pg
npm install --save-dev @types/pg
```

A database administrator must install pgvector and enable it in the target
database with `CREATE EXTENSION vector;`. Tessar checks for the extension and
does not install it. The application role needs schema/table/index creation and
read/write permissions. Configure connection strings, TLS and pooling on `pg`:

```ts
import { Pool } from "pg";
import { PostgresqlVectorStore } from "@tessar/postgresql/vector";
import type { Chunk, EmbeddingModel } from "@tessar/rag";

async function saveAndSearch(chunks: Chunk[], embedding: EmbeddingModel) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
  try {
    const store = new PostgresqlVectorStore({
      pool,
      embedding,
      schema: "tessar", // Optional, defaults to "tessar".
      collection: "handbook", // Optional, defaults to "default".
    });
    try {
      await store.insert(chunks);
      console.log(await store.info());
      return await store.search("How do I configure the application?", {
        topK: 5,
        filter: { metadata: { project: "handbook" } },
      });
    } finally {
      await store.close();
    }
  } finally {
    await pool.end();
  }
}
```

The constructor validates configuration synchronously. The first asynchronous
operation lazily initializes metadata, tables and indexes; connection or database
initialization errors reject that operation. `close()` only closes the store
facade. The borrowed pool stays open, including after initialization failure;
borrowed clients are released on success and failure.

`insert` accepts Content/Chunk arrays, calls `embedDocuments` outside the database
transaction and atomically saves the batch with generated UUIDs and UTC timestamps.
Complete content, source, metadata, position and original vectors are retained in
JSONB. Repeated inserts generate new records. `info()` returns collection name,
saved model identity and dimensions. Identity must match when reopening a collection;
dimensions remain null until its first successful insert and survive deletion.
Dimensions are inferred from actual model output, with no probe calls, automatic
re-embedding or conversion to another embedding model.

`get(id)` returns a record or null. `list({ limit, offset, filter })` uses insertion
order, with limit default 100/max 1000 and offset default 0. `delete({ ids })` or
`delete({ filter })` returns a deletion count. Filters support exact source URI/page
and top-level scalar metadata equality, combined with AND; text filters are not
supported. Filter deletion requires a nonempty filter.

`search(query, options?)` requires nonblank question text. Options are `topK`
(default 5), `score_threshold` (inclusive cosine minimum from -1 to 1) and `filter`.
Results contain `id`, `createdAt`, complete `content` and descending cosine `score`,
without vectors. Empty collections return [] without an embedding call. Reads,
listing, deletion and info do not call the model. Insert/search validate output
dimensions; incompatible output rejects without automatic re-embedding.

Search uses native pgvector float32 vectors and a per-collection HNSW cosine index
created with the first successful insert, in the same transaction as dimensions
and records. Native HNSW `vector` indexes support at most 2000 dimensions; larger
outputs reject rather than selecting halfvec or reducing dimensions. Original
vectors are retained separately for readback. Unfiltered search is approximate;
topK is a maximum, not a guarantee of that many results. HNSW's server candidate
budget (`hnsw.ef_search`, default 40) and dead tuples can reduce result counts.
The developer owns server tuning; Tessar does not change global settings or
automatically tune the index. See
[pgvector's result-count guidance](https://github.com/pgvector/pgvector#why-are-there-less-results-for-a-query-after-adding-an-hnsw-index).
Filtered search ranks the matching subset exactly before topK and may cost more
for broad filters. Scores are similarities, not relevance percentages.

Native driver/database errors propagate. No live remote deployment verification
is claimed. Vector storage adds no agent context injection or document lifecycle.

### Keyword search

`searchBM25(query, { topK?, filter? }?)` searches saved content using the
`pg_search` extension's BM25 ranking. An administrator must separately install
the extension on the PostgreSQL server and enable it in the target database
with `CREATE EXTENSION pg_search;`, following that extension's server setup
requirements. Tessar never installs extensions or changes server configuration.
This requirement is separate from pgvector: missing `pg_search` rejects only
`searchBM25`; CRUD, vector search and native keyword search remain available.

The first BM25 call creates its native index and backfills existing records.
Subsequent inserts/deletes are maintained by the native index. Initial indexing
can add latency and disk usage. The application role needs index creation
permissions. No embedding model is called for keyword search or indexing.

`searchNative(query, { topK?, filter? }?)` uses PostgreSQL's built-in text search
with explicit `simple` configuration and `ts_rank` ranking; it requires no BM25
extension. A GIN index supports native text lookup. It does not provide BM25
ranking, stemming or automatic language inference.

```ts
const bm25 = await store.searchBM25("configuration Tessar", {
  topK: 5,
  filter: { metadata: { project: "handbook" } },
});
const native = await store.searchNative("configuration Tessar", { topK: 5 });
```

Both methods require nonblank plain query text and treat literal terms as OR
alternatives, without exposing search operators. Options are optional: `topK`
defaults to 5 and source/metadata filters use the same AND rules as vector
search, applied before topK. No matches return []. Results contain `id`,
`createdAt`, complete `content` and descending `score`, without vectors. BM25
scores and native `ts_rank` scores are different ranking scales; neither is a
cosine similarity or a relevance percentage. Neither method accepts
`score_threshold`. Combining keyword and vector results remains application code.
