# @tessar/mongodb

MongoDB storage for Tessar using the native `mongodb` driver. Requires a replica
set or sharded MongoDB deployment supporting transactions; standalone servers are
rejected during setup. Repository CI is configured to test a MongoDB 8 replica set.

```ts
import { MongoClient } from "mongodb";
import { MongoDBStoragePlugin } from "@tessar/mongodb";

const client = new MongoClient(process.env.MONGODB_URL!, { maxPoolSize: 10 });
await client.connect();
const storage = new MongoDBStoragePlugin({
  database: client.db("my_agent"),
  namespace: "agent_state", // Optional collection prefix.
});
// Include storage in your Tessar plugins configuration.
// After Tessar shuts down, the application closes its client:
// await client.close();
```

`createMongoDBBackend(options)` exposes the same backend directly. The plugin
registers it with `tessar.storage.register`. Install `mongodb@^6.21.0` alongside
this package. The application selects the database and owns its MongoClient,
including TLS/pool configuration, connecting, and closing. Tessar never creates,
connects, or closes the client, including after initialization failures and plugin
disposal. Backend `close()` is an idempotent no-op; each transaction still ends
its own session. Stop Tessar operations before closing the application client.

The database contains `tessar_*` collections for sessions, plugin state, thread
heads, checkpoints, version intervals, staging and commit receipts. An optional
`namespace` prefixes every collection, including schema metadata: `agent_state`
uses `agent_state_tessar_threads` and `agent_state_tessar_schema`. Omit it to keep
existing `tessar_*` names. Namespaces must match `[A-Za-z_][A-Za-z0-9_]{0,62}`;
an empty or invalid value is rejected. Each namespace has independent data and
schema metadata; changing it selects another set of collections without migrating
data. Application collections are left alone. Messages and
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

The adapter separates connection access in `database.ts`, native transaction
lifecycle in `transaction.ts`, and schema setup in `schema.ts`. The backend factory
initializes state collections; vector-only use reuses connection/transaction helpers
without initializing state collections. `ownership.ts`, `versions.ts` and `queries.ts`
implement leases, history and paging; `backend.ts` wires the storage contract.
It follows the same logical storage rules as libSQL/PostgreSQL;
native collections and transactions implement those rules.

Use `backend.records.append/get/list` for independent JSON entries, or
`tessar.storage.records` in a plugin after Controller initialization. One
`tessar_records` collection stores entries separately from conversation versions
and checkpoints; initialization adds it and its indexes to existing databases.
Each append is an atomic document insert. See
[independent records](../../examples/guide/storage.md#store-independent-json-records)
for parameters, scope filtering, duplicate identity behavior and pagination.

## Independent vector storage

`MongoDBVectorStore` from `@tessar/mongodb/vector` stores Content/Chunk records
independently of Agent, Controller, Session and checkpoint storage. Install the
optional RAG peer explicitly; the root storage entry does not require it:

```sh
npm install @tessar/core @tessar/mongodb @tessar/rag mongodb
```

```ts
import { MongoClient } from "mongodb";
import { MongoDBVectorStore } from "@tessar/mongodb/vector";
import type { Chunk, EmbeddingModel } from "@tessar/rag";

async function saveAndSearch(chunks: Chunk[], embedding: EmbeddingModel) {
  const client = new MongoClient(process.env.MONGODB_URL!);
  try {
    await client.connect();
    const store = new MongoDBVectorStore({
      database: client.db("my_agent"),
      embedding,
      namespace: "app", // Optional collection prefix.
      collection: "handbook", // Optional, defaults to "default".
    });
    try {
      await store.insert(chunks);
      console.log(await store.info());
      console.log(await store.list({ limit: 20 }));
      return await store.searchNative("configuration Tessar", { topK: 5 });
    } finally {
      await store.close();
    }
  } finally {
    await client.close();
  }
}
```

Supply a native `Db` and embedding model. Namespace omission retains Tessar's
default naming; collection defaults to `"default"`. Configure TLS, pooling and
connection lifecycle on the application-owned MongoClient. Tessar never connects
or closes that client, including after initialization failure; `close()` only
invalidates the store facade. A replica set or sharded deployment supporting
transactions is required for atomic bulk insertion. Embedding calls run outside
transactions and transaction sessions are ended on success and failure.

`insert`, `info`, `get`, `list` and `delete` follow the shared RAG storage
contract. Inserts retain complete Content/Chunk data and original vectors,
generate UUIDs and UTC timestamps, and atomically save each batch. Model identity
is persisted per collection; dimensions are inferred from the first successful
insert, null beforehand and retained after deletion. Incompatible identity or
output rejects without automatic re-embedding. `get` returns a record or null;
list supports insertion-order limit/offset pagination (limit default 100/max
1000). Delete accepts IDs or a nonempty filter and returns a deletion count.

Filters use exact source URI/page and top-level scalar metadata equality combined
with AND. Scalar types stay distinct, including null versus a missing key. No text
filter or MongoDB query operators are exposed. Tessar indexes canonical internal
filter tokens, so new metadata keys require no filter-field configuration or
index-definition changes. These tokens add storage overhead; values producing a
token over 32766 bytes reject before embedding rather than silently disappearing
from the search index. Original metadata is preserved.

### Vector and keyword search

All search methods take required nonblank query text and optional `{ topK,
filter }`; topK defaults to 5 and filters restrict matches before topK. Results
contain `id`, `createdAt`, complete `content` and descending `score`, without vectors.

- `search(query, { topK?, score_threshold?, filter? }?)` embeds the query and uses
  native `$vectorSearch` with `exact: true`. No ANN candidate/tuning configuration
  is inferred. MongoDB's cosine score [0, 1] is converted to shared cosine
  similarity [-1, 1]; optional score_threshold is an inclusive minimum in [-1, 1].
  Exact search can cost more on large collections.
- `searchBM25(query, { topK?, filter? }?)` uses MongoDB Search `$search` with an
  explicit BM25 similarity mapping. Scores are BM25 values, not cosine similarities.
- `searchNative(query, { topK?, filter? }?)` uses ordinary MongoDB `$text` and
  `textScore`, with language `none`. It requires no mongot or BM25 service and adds
  no stemming or language inference. Native textScore is not BM25 or cosine.

Both keyword methods treat plain literal terms as OR alternatives without exposing
query operators, make no embedding calls and accept no score_threshold. No matches
return []. Only insertion and vector search call the embedding model.

Vector Search and BM25 require a compatible Atlas deployment or a self-managed
MongoDB Search/mongot service provisioned by the developer. Tessar never installs
services or changes server configuration. Ordinary CRUD and native text search do
not require mongot. Tessar creates only its own collections and indexes, choosing
index names, dimensions and filter fields without application configuration.

Each search index is created lazily on its corresponding first search, including
the ordinary native text index. Vector/BM25 search-index creation and data visibility
are asynchronous. Each search checks queryable state: a building index rejects
with `InvalidState`, without a hidden wait loop. An incompatible existing index
definition rejects with `InvalidConfiguration`, without automatic replacement or
updates. Missing search-service errors propagate. Successful get/list can read
committed inserts immediately; search results may lag inserts/deletes even when
the index is queryable. Applications decide when to retry readiness errors.

Repository tests use `TESSAR_TEST_MONGODB_URL` for ordinary replica-set storage and
native text tests, and optional `TESSAR_TEST_MONGODB_SEARCH_URL` for a compatible
Search deployment. Skipped tests do not verify either backend. No live deployment
verification is claimed here.
