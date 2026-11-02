# Read and chunk content for retrieval

[All guides](README.md) · [Package API](../../packages/rag/README.md) ·
[Shared RAG specification](../../docs/superpowers/specs/2026-10-29-rag-design.md)

Install `@tessar/rag` in a Node.js >=24.22.1 application. `DocumentReader` loads
sources and `DocumentSplitter` chunks extracted content without an Agent,
Controller or Session. Compose these operations with the storage, embedding,
retrieval and agent-context workflow your application needs.
For browser applications, expose reading through your own backend when the
source is a file on the server.

Create `read-content.ts`:

```ts
import { DocumentReader } from "@tessar/rag";

const reader = new DocumentReader();
const reading = reader.load(
  {
    id: "read-notes",
    source: { text: "# Setup\n\nRun the application locally.", mimeType: "text/markdown" },
  },
  { metadata: { project: "handbook", revision: 1 } },
);

for (const content of await reading.result()) {
  console.log(content.format, content.text);
  console.log(content.source, content.metadata);
}
```

Run it with `node read-content.ts`. The read starts when `load()` is called;
`result()` awaits its outcome and returns an array even for one item. The task's
ID identifies this execution. Omit `id` to generate a UUID. Repeated `result()`
calls return the same promise.

## Load a file, URL or bytes

Continue the example with one source variant per call:

```ts
const file = await reader.load({ source: { path: "./manual.pdf" } }).result();
const remote = await reader.load({
  source: { url: "https://example.com/handbook.md" },
}).result();
const inline = await reader.load({
  source: { data: new TextEncoder().encode("plain text"), mimeType: "text/plain" },
}).result();
```

Paths resolve on the application machine. Files use extensions to select an
extractor. URLs use a supported response Content-Type, falling back to the URL
extension only when that header is absent or `application/octet-stream`. Byte
input requires a MIME type; inline text defaults to `text/plain`.

Supported formats are plain text, Markdown, HTML, JSON, CSV, native PDF text,
DOCX and XLSX. HTML becomes Markdown and CSV becomes an escaped Markdown table.
JSON is validated and returned as its original text. PDF content identifies
actual source pages, starting at 1, retaining empty pages if another page has
text; a PDF with no extractable text rejects with `ExtractionUnavailable`. DOCX returns
plain text without promising headings or table structure. XLSX returns text per
sheet, with its name included in the text. OCR and model-based extraction are
not invoked.

`content.format` describes the returned text representation. `content.source`
can hold the absolute file URI or final HTTP URL, plus a page only when the
reader knows an actual source page. Metadata is a separate JSON object copied
from the caller; it defaults to `{}`. The reader does not assign page numbers
to formats without fixed pages or turn extraction units into chunks.

## Chunk the results

```ts
import { DocumentSplitter } from "@tessar/rag";

const contents = await reader.load(
  { source: { path: "./manual.pdf" } },
  { metadata: { tenantId: "company-a", category: "handbook" } },
).result();
const splitter = new DocumentSplitter({
  strategy: "recursive",
  maxSize: 1000,
  overlap: 100,
});
const chunks = splitter.chunk(contents);

for (const chunk of chunks) {
  console.log({
    text: chunk.text,
    page: chunk.source?.page,
    position: chunk.position,
    metadata: chunk.metadata,
  });
}
```

`strategy` and `maxSize` are required. `overlap` defaults to 0, `unit` to
`characters` (Unicode code points). Values above illustrate configuration.
`character` uses windows; `recursive` prefers paragraphs/lines/words; `sentence`
keeps whole sentences where they fit; `markdown` recognizes headings, paragraphs,
lists, tables and fenced code. Each strategy subdivides oversized content.
Oversized Markdown table/code fragments may not be standalone valid Markdown.

The call returns `Chunk[]` synchronously. A single Content works too. Every chunk
retains the original format/source and an independent copy of its metadata.
`source.page: 3` means the chunk is on page 3, not that the PDF has three pages.
Each Content is processed separately; reader-produced PDF chunks stay on one
page. `position.contentIndex` identifies the zero-based input item, while
`start/end` are UTF-16 offsets into its text, with end excluded:

```ts
const chunk = chunks[0];
if (chunk) {
  const original = contents[chunk.position.contentIndex]!;
  console.log(original.text.slice(chunk.position.start, chunk.position.end) === chunk.text);
}
```

For token budgets, supply your destination model's local tokenizer explicitly:

```ts
// Install js-tiktoken in the application if this encoding matches your model.
import { getEncoding } from "js-tiktoken";

const encoding = getEncoding("cl100k_base");
const tokenChunks = new DocumentSplitter({
  strategy: "sentence",
  maxSize: 500,
  overlap: 50,
  unit: "tokens",
  tokenizer: { count: text => encoding.encode(text).length },
}).chunk(contents);
```

Token counts are computed for complete assembled text, not added across pieces.
Overlap is a maximum target at strategy boundaries and may be smaller to fit
new content. No embeddings, persistence or model calls happen during splitting.
Use a worker for large synchronous jobs. See the [package API](../../packages/rag/README.md#split-content)
for parameter validation, empty-input behavior and errors.

## Use an embedding implementation

Ingestion and retrieval can accept the same exported `EmbeddingModel` type:

```ts
import type { EmbeddingModel, Chunk } from "@tessar/rag";

async function createVectors(
  model: EmbeddingModel,
  chunks: readonly Chunk[],
  question: string,
) {
  const documents = await model.embedDocuments(chunks);
  const query = await model.embedQuery(question);
  return { documents, query };
}
```

Supply a provider/application object implementing these two methods and exposing
a readonly `ref` (`providerId`, `modelId`, optional `connectionId`).
`embedDocuments()` accepts strings, Content[] or Chunk[] directly and extracts
each object's text; it returns one vector per input in the original order.
Passing Content pages embeds per page; passing chunks embeds per chunk.
`embedQuery()` returns a single vector. These methods are still independently
usable; when using a vector store, pass the model into it instead of manually
embedding and pairing chunks/vectors.

This is a type-only contract, not a built-in embedding model or pipeline runner.
Provider-specific task options/instructions belong to the selected adapter,
which documents its supported scope and any configurable exceptions.

For an OpenAI embeddings endpoint, install `@tessar/openai` and pass its model:

```ts
import { OpenAIEmbedding } from "@tessar/openai";

const model: EmbeddingModel = new OpenAIEmbedding({
  apiKey: process.env.OPENAI_API_KEY,
  model: "text-embedding-3-small",
});
```

Pass this configured model into the store for both insertion and semantic search.
For large input arrays, add `batchSize: 100` and `concurrency: 3` to the embedding
constructor. The adapter splits arrays without changing text and returns vectors
in input order. Omitting batchSize sends one request; concurrency defaults to 1.
Provider errors propagate; no token budgeting or content truncation is added.
The same configuration applies when the store calls embedDocuments during insert.
The two embedding methods remain available for independent use. Metadata and
chunk source remain application data. See the
[OpenAI embedding guide](../../packages/openai/README.md#embeddings) for dimensions,
connection options, SDK retry/timeout behavior and provider errors.

For compatible endpoints requiring task fields, configure each method explicitly:

```ts
const gatewayEmbedding = new OpenAIEmbedding({
  apiKey: process.env.EMBEDDING_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  model: "your-embedding-model",
  documentOptions: { input_type: "search_document" },
  queryOptions: { input_type: "search_query" },
});
```

Use the field names and values required by that endpoint/model. For example,
some endpoints use `task` instead of `input_type`. Tessar forwards these optional
JSON body fields unchanged; omitted options keep the SDK/server defaults.

## Persist chunks and embeddings in libSQL

Install `@tessar/libsql` alongside the RAG and embedding packages. RAG is an
optional peer of libSQL: it must be installed explicitly to use the `/vector`
entry, while state-only consumers do not need it. Continue from
the `chunks` and configured `model` above; no additional mapping is needed:

```ts
import { LibsqlVectorStore } from "@tessar/libsql/vector";

const store = new LibsqlVectorStore({
  filename: "./vectors.db",
  collection: "handbook", // Optional, defaults to "default".
  embedding: model, // Configure once; dimensions are inferred from actual output.
});
try {
  await store.insert(chunks);
  console.log(await store.info()); // { collection, model: model.ref, dimensions }
  // Works after restarting too; retaining insert's returned IDs is optional.
  const records = await store.list({ filter: { metadata: { project: "handbook" } }, limit: 20 });
  for (const record of records) console.log(record.id, record.createdAt, record.content);
  const selected = records[0];
  if (selected) {
    const saved = await store.get(selected.id);
    console.log(saved?.vector);
    await store.delete({ ids: [selected.id] });
  }
} finally {
  await store.close();
}
```

The store calls embedDocuments once per nonempty insert, generates and persists
UUIDs and UTC insertion dates, validates model output and commits each insert atomically. Complete chunk
content is retained, including source/metadata/position. Repeated inserts create
new records. Collections isolate data in one file; different files are separate
databases. Model identity is saved per collection and must match when reopening.
Dimensions come from the first successful insert, remain null beforehand, and
survive deleting all records. Every insert/search validates output dimensions.
No probe embedding calls are made. Old collections without a saved model ref
reject without automatic adoption, migration or re-embedding.

List uses insertion-order pagination (`limit` default 100/max 1000, `offset`
default 0). Filters support exact source
URI/page and exact top-level scalar metadata; combine fields with AND. Delete
accepts either IDs or the same nonempty filter and returns a deletion count.
You do not need to attach metadata beforehand to discover or delete saved content.
See [libSQL vector storage](../../packages/libsql/README.md#independent-vector-storage)
for filter limits, error handling and connection behavior.

Storage needs no Agent/Controller/Session or extension. It maintains a native
cosine index per collection in the same transactions as the saved rows. Original
JSON vectors remain intact for readback; indexing uses float32. Missing indexes
are built from saved rows when opening a labelled collection. Only insert and
semantic search call the configured model; read/list/delete/info/BM25 do not.
No document lifecycle management is added. Large batches/index
builds run synchronously and can block the event loop. Native database errors
propagate; validation errors use TessarRagError. The package supports RAM/local
files through filename; remote/sync configuration has not been added.

## Search for related chunks

After inserting documents, pass a question directly to the same store:

```ts
const question = "What does the handbook say about configuration?";
const results = await store.search(question, {
  topK: 5,
  score_threshold: 0.7, // Omit for no minimum score.
  filter: {
    source: { uri: "file:///manual.pdf" },
    metadata: { project: "handbook" },
  },
});
for (const result of results) {
  console.log(result.id, result.createdAt, result.score, result.content.text);
  console.log(result.content.source, result.content.metadata);
}
```

Keep the store open while searching, then call `close()` in your application's
cleanup. Nonblank question text is required; options are optional. `topK` defaults
to 5 and must be a positive safe integer. Results contain
`id`, `createdAt`, `content` and `score`, preserving complete chunk provenance
without returning embedding vectors. Empty collections return [] and small
collections can return fewer than topK items.

Without a filter, libSQL searches the native approximate float32 cosine index and
sorts candidates by descending cosine similarity (`score = 1 - cosine distance`):
larger means nearer, typically -1 to 1, not a percentage of relevance. Floating-point
rounding can slightly exceed those bounds. Exact global nearest neighbors and stable selection among ties
are not guaranteed. The store calls embedQuery once and checks that its output
matches saved dimensions, contains finite numbers and has nonzero direction.
An empty collection returns [] without calling the provider. Invalid input rejects with
TessarRagError/InvalidData; native engine errors are preserved.

`score_threshold` is an optional finite number from -1 to 1; results at or above
it are retained. No threshold is applied when omitted. Filter uses the same
source and scalar metadata equality rules as list/delete, combined with AND;
text filters are not supported. Filtering restricts the dataset before topK.
Because libSQL's ANN function cannot prefilter these conditions, filtered
searches compute exact scores over matching rows rather than selecting only
global ANN candidates. This can cost more for broad filters/large collections.
Both paths use float32 vectors and may return fewer than topK above the threshold.

This method performs vector search only. No hybrid fusion, reranking or
automatic context injection is performed. The application decides whether to
use these chunks in a tool, `context.prepare`, or a separate flow.

## Search text with BM25

To find saved chunks by keywords, pass ordinary query text directly to the store:

```ts
const matches = await store.searchText("configuration Tessar", {
  topK: 5,
  filter: { metadata: { project: "handbook" } },
});
for (const match of matches) {
  console.log(match.id, match.createdAt, match.score, match.content.text);
}
```

`query` is required, nonblank and must not contain NUL; the whole options object can be omitted.
`topK` defaults to 5. The optional filter uses the same source/metadata AND rules
as list/delete and is applied before topK, with no text filter. No match returns
[]. Query segments separated by whitespace are treated as literal phrases,
combined with OR; matching uses the backend's default FTS5 unicode61 tokenizer.
FTS operators, prefixes and column selectors are not exposed. Punctuation-only
input without searchable tokens returns []. No language-specific tokenizer or
stemming is added.

libSQL maintains one FTS5 text index per collection on insert/delete, and builds
a missing index from saved content when opening an existing collection. BM25
uses collection-wide statistics even with a metadata/source filter. Results
retain original Content/Chunk provenance and omit vectors. Score is `-bm25()`:
larger means a better keyword match, not a percentage or cosine similarity.
There is no cosine score_threshold option for this method. Do not add BM25 and
cosine scores directly when combining results; hybrid fusion is a separate step.

This method calls no embedding model. Invalid queries/options reject with
TessarRagError/InvalidData; closed stores reject with InvalidState; native errors
propagate. Text index backfill adds synchronous startup work and disk usage.
Reranking, hybrid fusion and context injection remain application decisions.

## Rerank candidates

Install `@tessar/openai` to call the rerank model. `OpenAIReranker` calls an endpoint accepting the `model`, `query`, `documents` and
`top_n` rerank protocol. It works independently of the store and embedding model:

```ts
import { OpenAIReranker } from "@tessar/openai";

const reranker = new OpenAIReranker({
  endpoint: "https://openrouter.ai/api/v1/rerank",
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "cohere/rerank-4-pro",
});
const candidates = await store.search("How do I run locally?", { topK: 20 });
const ranked = await reranker.rerank("How do I run locally?", candidates, {
  topK: 5,
  score_threshold: 0.3,
});
for (const { document, score } of ranked) {
  console.log(document.id, document.content.text, score);
}
```

Strings, Content and Chunk arrays also work directly. Only text is sent to the
endpoint. Each result contains the original candidate as `document` and the
provider's rerank score as `score`; an original search score stays inside
`document.score`. Results are sorted descending. `topK` defaults to 5 and is
capped at the candidate count. Threshold is optional and uses the provider's
score scale; it is not necessarily cosine similarity or a probability.

For native Cohere, use `https://api.cohere.com/v2/rerank` with its API key/model.
The endpoint must implement this protocol; Tessar does not infer it from model
names. Empty candidates return [] without a request. Transport errors propagate;
HTTP failures use TessarError `RerankFailed` with `details.status`, malformed
results use `InvalidData` with source `provider`. No automatic retries are added.
Hybrid fusion and selection of candidates remain application decisions.

## Cancel an active read

Keep the handle wherever the application routes cancellation:

```ts
import { TessarError } from "@tessar/core";

const pending = reader.load({ source: { url: "https://example.com/manual.pdf" } });
const result = pending.result();
pending.cancel("User cancelled");
try {
  await result;
} catch (error) {
  if (TessarError.isInstance(error) && error.code === "Cancelled") {
    console.log("Read cancelled", pending.id);
  } else {
    throw error;
  }
}
```

Cancellation affects this execution only. It propagates to supported I/O;
arbitrary synchronous parser work cannot be interrupted. Cancelling after
completion does not change the result. An active ID cannot be reused on the
same reader until the underlying operation finishes cleanup.

Invalid input and duplicate active IDs throw from `load()`. Unsupported formats,
I/O and extraction errors reject `result()`. Native I/O and parser errors retain
their classes; catch or propagate them according to application policy.
