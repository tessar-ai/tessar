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

Supply a provider/application object implementing these two methods.
`embedDocuments()` accepts strings, Content[] or Chunk[] directly and extracts
each object's text; it returns one vector per input in the original order.
Passing Content pages embeds per page; passing chunks embeds per chunk.
`embedQuery()` returns a single vector. Keep chunk metadata/provenance separately
and associate documents[i] with chunks[i].

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
const documentVectors = await model.embedDocuments(chunks);
const queryVector = await model.embedQuery("What does the handbook say?");
```

Use the same compatible model/embedding-space configuration for both sides of a
search. Metadata and chunk source remain application data. See the
[OpenAI embedding guide](../../packages/openai/README.md#embeddings) for dimensions,
connection options, SDK retry/timeout behavior and provider errors.

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
