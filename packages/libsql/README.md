# @tessar/libsql

The root entry provides state/checkpoint storage and does not require or install
RAG. Vector storage, vector search and BM25 are exported only from
`@tessar/libsql/vector`. To use that entry, explicitly install its optional peer:

```sh
npm install @tessar/libsql @tessar/rag libsql@0.5.29
```

`@tessar/rag` supplies the vector contracts and TessarRagError. It is an optional
peer dependency, not an automatically installed dependency; importing `/vector`
without it fails. State-only users install `@tessar/libsql` and `libsql@0.5.29` and import
from its root. The driver is an optional peer installed explicitly by consumers
and a development dependency for tests. Core remains a runtime dependency.

## Independent vector storage

`LibsqlVectorStore` embeds and stores content independently from agent state.
It needs no Controller, storage plugin or extension. The entire
package uses the same synchronous `libsql` driver for state and vectors.

```ts
import Database from "libsql";
import { LibsqlVectorStore } from "@tessar/libsql/vector";
import { OpenAIEmbedding } from "@tessar/openai";

const embedding = new OpenAIEmbedding({
  apiKey: process.env.OPENAI_API_KEY,
  model: "text-embedding-3-small",
});

const database = new Database("./vectors.db");
try {
  const store = new LibsqlVectorStore({
    database,
    collection: "handbook", // Optional; defaults to "default".
    embedding, // Configure the model once; dimensions come from its output.
  });
  try {
    const ids = await store.insert(chunks);
    const records = await store.list({ filter: { metadata: { project: "handbook" } }, limit: 20, offset: 0 });
    const first = records[0];
    if (first) {
      console.log(await store.get(first.id));
      await store.delete({ ids: [first.id] });
    }
    console.log(ids);
  } finally {
    await store.close();
  }
} finally {
  database.close();
}
```

`insert(contents)` accepts a readonly Content[] or Chunk[] from `@tessar/rag`.
The store validates/copies content, then calls the supplied model's
`embedDocuments()` once and associates returned vectors by input order. It keeps
text, format, source, metadata and chunk position; only the adapter decides what
to send to the provider. Outputs must contain one finite nonzero vector per input,
all with the same dimensions. Empty arrays insert nothing and make no model call.
Provider calls run outside the database transaction; saved rows and both indexes
commit atomically after validation. Provider errors retain their identity.

Each saved record is `{ id, createdAt, content, vector }`. IDs are generated UUIDs;
createdAt is an automatic ISO 8601 UTC insertion time. Neither may be supplied by
the caller. Insert returns IDs in input order; ignoring them does not lose access
to records. List/get return persisted IDs and dates after restart. Re-inserting
the same content creates new records, not updates.

`list(options?)` returns up to `limit` records (default 100, maximum 1000), ordered
by insertion sequence. `offset` defaults to 0. It returns [] when no rows match.
Pages are not a snapshot if other connections insert/delete between calls.
`get(id)` returns one record or null, always within the selected collection.

List and delete share a filter. All specified conditions must match:

```ts
const records = await store.list({
  filter: {
    source: { uri: "file:///manual.pdf", page: 3 }, // Exact matches.
    metadata: { project: "handbook", active: true }, // Exact top-level JSON scalars.
  },
});
const count = await store.delete({ filter: { source: { uri: "file:///manual.pdf" } } });
```

Metadata is optional for finding/removing data: source filters and persisted
IDs work without inventing application metadata. Metadata filter values support
string, finite number, boolean and null (null matches a present null, not a missing
key). Nested metadata filters and query operators are not supported. Filters use
bound parameters. Text filtering is not supported. Empty filters/conditions
are rejected. Omit filter to list all records, within the page limit.

`delete({ids})` or `delete({filter})` permanently deletes matching records and
returns a count. Exactly one selector is required; empty ID arrays and empty
filters are rejected. Duplicate IDs count each deleted row once.

The store creates `tessar_vector_models`, `tessar_vector_collections`, `tessar_vectors` and a native
vector table/index for each collection. The same database/namespace/collection
shares data. Collections are logical groups within a namespace, not schemas.
Namespaces isolate tables, indexes and metadata. Existing collection model
identity/dimensions cannot be silently changed. State and vectors may borrow
the same database; closing either handle leaves the native database open.

Constructor validation/model identity conflicts throw TessarRagError with code
InvalidConfiguration. Invalid content, vectors, queries or selectors reject with
InvalidData, including a provider returning incompatible dimensions. Closed-handle
operations reject with InvalidState; close is idempotent.
Use `TessarRagError.isInstance(error)` from `@tessar/rag` or the parent TessarError
guard. Native SQLite/I/O errors retain their identity; transaction failures roll
back without replacing the original error. No automatic retries.

libSQL work is synchronous internally even though methods return promises; large
batches and index builds can block the event loop. Each collection gets its own
native cosine vector index, updated atomically with insert/delete. Opening a
collection builds a missing index over saved records without changing their IDs,
dates or content. Existing indexes are reused. Original vectors remain JSON for
exact readback; the index stores a float32 representation. Insert/query validation
rejects magnitudes that overflow or underflow the native cosine norm calculation
with `InvalidData`; vectors are never automatically normalized or rewritten.
This includes subnormal norm products, which have too little float32 precision.
Finite cosine scores are bounded to [-1, 1] before applying score_threshold.
Search also rejects nonfinite similarity scores from damaged or legacy indexes.
Index settings use engine defaults; building large or high-dimensional indexes
can be expensive.

`info()` returns `{ collection, model, dimensions }`. The model is a captured
readonly `embedding.ref` (`providerId`, `modelId`, optional `connectionId`) saved
once per collection. Dimensions are null until the first successful nonempty
insert; they are inferred from actual output and retained even after deleting
all records. No constructor/empty-collection probe calls are made. Another handle
can initialize dimensions; each operation checks committed collection metadata.
Opening with a different ref fails. Legacy collections without a stored model
identity are rejected, not adopted, rewritten, deleted or re-embedded. The store
cannot prove embedding-space compatibility beyond declared identity and actual
dimensions; provider-side revisions/config changes remain the developer's concern.

### Vector search

Pass question text; the store calls its configured model's `embedQuery()` once
and searches the selected collection:

```ts
const results = await store.search("How do I configure Tessar?", {
  topK: 5,
  score_threshold: 0.7, // Optional inclusive minimum cosine similarity.
  filter: { metadata: { project: "handbook" } }, // Optional source/metadata.
});
// Or await store.search("How do I configure Tessar?"); options are optional.
for (const result of results) {
  console.log(result.id, result.createdAt, result.score, result.content);
}
```

`topK` is optional (default 5) and must be a positive safe integer. Search returns
up to that many `{ id, createdAt, content, score }` items, or [] for an empty
collection. Content retains source, metadata and chunk position; vectors are not
returned. The query must be nonblank text. Returned query vectors must match the
saved dimensions, contain finite numbers and have nonzero direction. Empty
collections return [] without calling the model. Raw vectors are not accepted.

Without a filter, search uses the float32 native cosine index (`vector_top_k`), which is
approximate and does not guarantee exact global nearest neighbors. Results are
sorted by descending cosine similarity (`score = 1 - cosine distance`, larger is
nearer, typically -1 to 1, not a relevance percentage). Floating-point rounding
can slightly exceed those bounds. Equal scores do not promise stable candidate
selection. This method does not run keyword search, rerank or put content into
agent context. Native engine errors propagate.

`score_threshold` is optional, finite and between -1 and 1. It includes scores
equal to the threshold; omitted means no threshold (negative scores are retained).
`filter` uses the same nonempty source/metadata equality conditions as list/delete,
combined with AND. Text filtering is not supported. Filters restrict the records
before topK is chosen; scores below the threshold are excluded, possibly leaving [].
libSQL's ANN function cannot prefilter arbitrary metadata, so filtered searches
score matching rows exactly using the stored float32 embeddings, then sort and
limit. They do not postfilter only the global topK, and do not use the ANN index
for candidate selection. Broad filters can therefore scan many rows and block
the event loop longer. There is no implicit oversampling or new index tuning.

### BM25 text search

Search the text of saved chunks without embedding the question:

```ts
const results = await store.searchBM25("configuration Tessar", {
  topK: 5,
  filter: { metadata: { project: "handbook" } },
});
// Or await store.searchBM25("configuration Tessar");
for (const result of results) console.log(result.score, result.content);
```

The query is required nonblank plain text without NUL characters. Options are optional; `topK` defaults
to 5 and must be a positive safe integer. `filter` supports the same nonempty
source/metadata equality conditions as list/delete (AND), applied before topK.
There is no `score_threshold`: BM25 is not on the cosine similarity scale.

`searchBM25` uses native FTS5 `bm25()`, not a Tessar ranking algorithm. Returns
`{ id, createdAt, content, score }[]` with original provenance, without vectors;
score is `-bm25()` so larger means better. It is not normalized to 0..1 or a
percentage and cannot be compared directly with vector scores. Results are
ordered by descending score, then insertion sequence; no matches returns [].

Whitespace-separated query segments are quoted literal phrases joined with OR,
so a document can match any segment. Quotes, operators such as NOT, column syntax
and wildcard characters are treated as input text, not FTS commands. The default
FTS5 unicode61 tokenizer handles case/punctuation/diacritics inside segments;
there is no language-specific segmentation, stemming or custom tokenizer option.
Punctuation-only queries with no searchable tokens return [].

Each collection has its own FTS5 table and BM25 corpus statistics. Filters
restrict results, not the collection statistics used to compute BM25. The text
index stores content.text and shares record sequence IDs with saved records;
insert/delete update text and vector indexes atomically. Opening an older
collection populates a missing text index without rewriting saved records.
Index creation/backfill is synchronous and adds disk space/startup cost for large
collections. No automatic document re-reading, hybrid fusion or reranking.

`close()` marks the store closed without closing the borrowed database. Close
the native database after all users finish. The current driver
can retain file handles on Windows after close, preventing immediate file deletion
until resources/processes release them. Database native error classes/codes are
those of libSQL (for example SQLITE_BUSY), not node:sqlite's ERR_SQLITE_ERROR.

## State and checkpoints

Local libSQL persistence for Tessar's state and checkpoint contracts.
Requires Node 24.22.1 or newer and a supported native `libsql` driver binary.

```sh
npm install @tessar/core @tessar/libsql libsql@0.5.29
```

```ts
import Database from "libsql";
import { LibsqlStoragePlugin } from "@tessar/libsql";

const database = new Database("./state.db");
const storage = new LibsqlStoragePlugin({ database, namespace: "app" });
// Include storage in new Controller({ id, agent, plugins: [storage, ...] }).
// After disposing the Controller, call database.close().
```

Core owns state/checkpoint behavior; this plugin supplies physical persistence.
Choose the backend before Controller initialization. Scope filters bind queries
to application-selected metadata; applications own authentication and authorization.

This backend uses synchronous database
operations and is a reference implementation, not a server throughput claim.

Configure RAM (`new Database(":memory:")`), local files, remote authentication
and embedded replicas on the native database. Call native `sync()` directly;
Tessar provides no sync wrapper. Live remote deployments have not been verified.
The application owns and closes the database, including after initialization
failure. Backend `close()` is a no-op because it owns no persistent resources.
Tessar does not override `journal_mode` or `busy_timeout`; foreign keys are enabled
for data integrity.

This is an early 0.x release. See the
[repository](https://github.com/tessar-ai/tessar) for usage and contracts.

## Schema v1

The current layout is schema v1, recorded in the namespaced `tessar_schema`
metadata table without writing global `PRAGMA user_version`. Initialization
creates missing tables and indexes transactionally and retains existing data;
it does not migrate application data. Omitted `namespace` retains existing
`tessar_*` names; `namespace: "app"` creates `app_tessar_threads`, for example,
and scopes all indexes and metadata. Namespaces must match
`[a-z_][a-z0-9_]{0,62}`; empty or invalid values are rejected.

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
