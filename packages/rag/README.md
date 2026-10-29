# @tessar/rag

Load sources and split extracted content for an application-managed retrieval
pipeline. `DocumentReader` and `DocumentSplitter` run independently of Agent,
Controller and Session. They do not persist results, create embeddings or inject context.
This is a Node.js SDK; a browser UI needs an application backend to read files
on that backend's machine.

## Install

Requires Node.js >=24.22.1:

```sh
npm install @tessar/rag
```

## Read content

```ts
import { DocumentReader } from "@tessar/rag";

const reader = new DocumentReader();
const reading = reader.load(
  { id: "read-manual", source: { path: "./manual.pdf" } },
  { metadata: { project: "handbook" } },
);
const contents = await reading.result();
for (const content of contents) {
  console.log(content.text, content.format, content.source, content.metadata);
}
```

`load(input, options?)` starts work and returns a task immediately. Supply exactly
one source form:

| Source | Behavior |
| --- | --- |
| `{ path: string }` | Resolve and read a local file; infer format from its extension |
| `{ url: string }` | Fetch an HTTP(S) resource; select its format from Content-Type or a fallback URL extension |
| `{ text: string, mimeType?: string }` | Read inline text; MIME type defaults to `text/plain` |
| `{ data: Uint8Array, mimeType: string }` | Extract from bytes using the required MIME type |

The optional second argument accepts only application `metadata`, a JSON object.
The reader copies input bytes and metadata so caller changes after `load()` do
not change the admitted read. Empty inline text is valid. HTTP(S) URLs must not
contain embedded credentials. Binary formats require byte, file or URL input.

For HTTP responses, MIME parameters such as `charset=utf-8` are stripped before
selecting a supported format. A missing or `application/octet-stream` Content-Type
falls back to the URL extension. An explicitly unsupported Content-Type rejects
the result, even if the URL has a supported extension.
Textual bytes are decoded as UTF-8; invalid encoding rejects rather than being
silently replaced. MIME charset parameters do not select a different decoder.

## Results and extraction limits

Every result is a `Content[]`. Each item contains:

```ts
interface Content {
  text: string;
  format: "text" | "markdown";
  source?: { uri?: string; page?: number };
  metadata: JsonObject;
}
```

`JsonObject` is the JSON-compatible object type from `@tessar/core`. Metadata
defaults to `{}` and contains only caller-supplied values. Source provenance is
separate: local paths become absolute file URLs and HTTP sources use the final
response URL. Inline sources have no invented URI.

| Input | Supported extensions | Supported MIME types | Output |
| --- | --- | --- | --- |
| Plain text | `.txt` | `text/plain` | Original UTF-8 text |
| Markdown | `.md`, `.markdown` | `text/markdown`, `text/x-markdown` | Original Markdown |
| HTML | `.html`, `.htm` | `text/html`, `application/xhtml+xml` | Markdown |
| JSON | `.json` | `application/json`, `text/json` | Original text after JSON validation |
| CSV | `.csv` | `text/csv`, `application/csv` | Escaped Markdown table |
| PDF | `.pdf` | `application/pdf` | Native text per page |
| DOCX | `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | Plain text |
| XLSX | `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | Plain text per sheet |

Input forms do not imply support for other formats. `format` describes the
returned string, so Markdown, HTML and CSV results are labelled `markdown`.
JSON is parsed to validate it, then its original text is returned without
reserializing numbers or changing formatting. CSV's first row becomes the
Markdown table header; no column schema is inferred.

PDF extraction uses native page text and reports actual one-based source page
numbers. Empty pages are retained when another page has text. A PDF without
extractable text rejects with `ExtractionUnavailable`.
There is no OCR, learned layout analysis or model invocation. DOCX returns plain
text without a heading or table-structure guarantee. XLSX returns text per sheet,
including the sheet name in its text, ISO strings for dates and cached formula
values. Ordinary text, Markdown, HTML, DOCX and
XLSX output does not invent fixed page numbers. Output items are extraction
units; they are not embedding chunks.

## Split content

```ts
import { DocumentReader, DocumentSplitter } from "@tessar/rag";

const contents = await new DocumentReader().load(
  { source: { path: "./manual.pdf" } },
  { metadata: { project: "handbook" } },
).result();

const splitter = new DocumentSplitter({
  strategy: "recursive",
  maxSize: 1000,
  overlap: 100,
});
const chunks = splitter.chunk(contents);
for (const chunk of chunks) {
  console.log(chunk.text, chunk.source?.page, chunk.position, chunk.metadata);
}
```

`chunk(input)` accepts a single `Content` or a readonly `Content[]` and returns
`Chunk[]` synchronously. It processes each Content independently in input order.
It also accepts application-created Content without reading a file first.
There is no splitter task lifecycle; applications can run large jobs in a worker.

| Constructor parameter | Required / default | Meaning |
| --- | --- | --- |
| `strategy` | Required | `character`, `recursive`, `sentence` or `markdown` |
| `maxSize` | Required | Positive safe integer in the selected unit |
| `overlap` | Default `0` | Nonnegative safe integer less than maxSize; maximum target overlap at strategy boundaries |
| `unit` | Default `"characters"` | `characters` (Unicode code points) or `tokens` |
| `tokenizer` | Required for tokens | Local synchronous `{ count(text: string): number }` |

The numbers in examples illustrate configuration, not universal quality settings.
`character` makes bounded windows. `recursive` prefers paragraphs, lines and words
before subdividing into characters. `sentence` uses native sentence boundaries,
packing whole sentences and subdividing oversized ones. `markdown` parses blocks
(including headings, lists, fenced code and tables) before splitting oversized
blocks. Overlap may be smaller than requested to preserve boundaries or make room
for new content. Every chunk advances to new content and respects maxSize.

Chunks preserve original text, including whitespace and line endings. Oversized
code blocks/tables can yield fragments that are not independently valid Markdown.
Headings and table headers are not automatically repeated or inserted.

```ts
interface Chunk extends Content {
  position: { contentIndex: number; start: number; end: number };
}
```

`contentIndex` is zero-based (0 for one Content). `start` and exclusive `end` are
UTF-16 offsets compatible with `contents[contentIndex].text.slice(start, end)`;
these offsets differ from code-point counts for characters such as emoji.
`source.page` is the one-based page containing the text, **not total pages**.
Reader-produced PDF chunks each belong to one actual page. Plain text and
Markdown have no invented pages. Chunks independently copy source and caller
metadata; framework position data stays outside metadata. No chunk ID is generated.

Empty inputs/text return no chunks. Invalid configuration/content or tokenizer
counts throw `TessarRagError`. A single code point exceeding a token budget also
throws; tokenizer exceptions retain their original identity.

### Token measurement

Choose a tokenizer compatible with the destination model, which may be an
embedding model rather than your chat model. For example, after installing
`js-tiktoken` in your application:

```ts
import { getEncoding } from "js-tiktoken";

const encoding = getEncoding("cl100k_base"); // Choose the encoding for your model.
const tokenSplitter = new DocumentSplitter({
  strategy: "sentence",
  maxSize: 500,
  overlap: 50,
  unit: "tokens",
  tokenizer: { count: text => encoding.encode(text).length },
});
const tokenChunks = tokenSplitter.chunk(contents);
```

Counts must be deterministic nonnegative safe integers. Tessar measures complete
assembled chunks; it does not assume token counts of separate pieces add up.
No tokenizer or model is selected automatically, and chunking makes no model calls.

## Embedding model contract

`EmbeddingModel` is an exported TypeScript interface shared by ingestion and
retrieval. It has no runtime constructor or built-in model implementation:

```ts
import type { EmbeddingModel, Chunk } from "@tessar/rag";

async function prepareVectors(
  model: EmbeddingModel,
  chunks: readonly Chunk[],
  question: string,
) {
  const documents = await model.embedDocuments(chunks);
  const query = await model.embedQuery(question);
  return { documents, query };
}
```

```ts
interface EmbeddingModel {
  embedDocuments(input: readonly (string | { text: string })[]): Promise<number[][]>;
  embedQuery(input: string): Promise<number[]>;
}
```

Document inputs accept strings or objects with text, including Content[] and
Chunk[]; lists may mix strings and text objects. The implementation extracts text
internally. Each element remains one embedding unit; passing Content pages does
not automatically chunk them. Document vectors correspond to inputs in order;
a query returns one vector.
Metadata/source remain with the application's Content/Chunk rather than being
sent automatically. Use a provider or application implementation with these
methods; structural typing does not require extending a framework base class.

Adapters have a defined provider/model scope. Native task parameters,
instructions and optional overrides belong to the adapter's configuration.
The interface does not infer settings from model names or claim automatic support
for every model. This contract alone makes no network calls, changes no input
text and adds no batching, retry or cancellation behavior. For the OpenAI
embeddings protocol, install `@tessar/openai` and supply its `OpenAIEmbedding`
class. Connection and native request options are documented in that package.

## Task identity and cancellation

```ts
const reading = reader.load({
  source: { url: "https://example.com/manual.pdf" },
});
const result = reading.result();
// An application can route a user cancellation to this handle.
reading.cancel("User cancelled");
try {
  await result;
} catch (error) {
  console.error(error);
}
```

An omitted ID generates a UUID. Supplied IDs must be nonempty; concurrent active
reads on the same reader cannot share an ID. Invalid input throws synchronously;
a duplicate active ID throws a `TessarRagError` with code `RegistrationConflict`.
IDs identify executions, not documents or output items.

Repeated `result()` calls return the same promise. `cancel(reason?)` affects only
that task and rejects its pending result with a `TessarRagError` whose code is
`Cancelled`. It has no effect after completion. Cancellation propagates to
supported I/O and is checked around extraction; synchronous parser work cannot
be forcibly interrupted. A cancelled ID remains active until underlying cleanup
settles. There is no public signal option or retained task registry.

Unsupported formats and read/extraction failures reject `result()`. Native
filesystem, network and parser exceptions retain their original classes;
reader-owned cancellation uses the Tessar cancellation error. Failures are not
returned as empty content or error items.
Non-success HTTP responses reject with `SourceReadFailed`, with the HTTP status
and response URL in the error's `details`.

## Identify RAG errors

`TessarRagError` extends the shared `TessarError` and inherits its constructor
`(code, message, options?)` and `isInstance(error: unknown)` guard. The guard
recognizes RAG-owned failures; the parent guard recognizes them as well.

```ts
import { DocumentReader, TessarRagError } from "@tessar/rag";

try {
  const reading = new DocumentReader().load({ source: { path: "./manual.pdf" } });
  const contents = await reading.result();
  console.log(contents);
} catch (error) {
  if (TessarRagError.isInstance(error)) {
    console.error(error.code, error.message, error.source, error.details);
  } else {
    throw error; // Native filesystem, network or parser exception.
  }
}
```

Codes include `InvalidConfiguration`, `InvalidData`, `RegistrationConflict`,
`UnsupportedFormat`, `SourceReadFailed`, `ExtractionUnavailable` and `Cancelled`.
Shared core validation failures retain their code/details and original cause
when attributed to this class. Invalid URL syntax is an input error with its
native URL error as cause. HTTP response failures keep source `provider`;
inheritance does not imply a framework-origin fault. Native external exceptions
are not wrapped solely to join this hierarchy.

See the [RAG guide](../../examples/guide/rag.md) and
[shared RAG specification](../../docs/superpowers/specs/2026-10-29-rag-design.md).
