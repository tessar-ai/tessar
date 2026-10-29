# RAG SDK specification

Status: incremental specification. The approved reader, splitter, embedding
contract and OpenAI embedding adapter are implemented and verified. Append later agreed capabilities
here; a pipeline example is not a requirement to implement each named stage.

## Principles

Provide independent tools that developers compose. No automatic document lifecycle,
indexing, agent-context injection, persistence or model calls. Core remains unchanged.
Classes hold configuration; `index.ts` exports public APIs only. Node >=24.22.1,
TypeScript ESM, package-local tests outside src, Apache-2.0.

## Content reader

The agreed signatures, input and output are in
[rag-content-reader-api.md](../../rag-content-reader-api.md). Publish the implementation
as `@tessar/rag@0.1.0` without publishing it during this task. Runtime export:
`DocumentReader`, `TessarRagError`. Type exports: `ReadInput`, `ReadSource`, `ReadOptions`, `ReadTask`,
`Content`. No public AbortSignal, adapter registry or extra task lifecycle API.

One synchronous `load({id?,source}, options?)` signature starts work and returns a
handle. Invalid arguments and active duplicate IDs fail synchronously. Missing IDs
use bare UUIDs. The active-ID set belongs to each Reader and is released after
underlying cleanup, including cancellation. `result()` returns the same Promise;
observe internal rejection so callers may attach later. Caller cancellation rejects
promptly with `TessarRagError` code `Cancelled`; late cancellation is a no-op. Native
I/O/parser errors are preserved. Snapshot source bytes and JSON metadata at admission.
Return JSON data with caller metadata kept separate from framework provenance.

`TessarRagError` extends core `TessarError`, following the TypeSafe error pattern.
It inherits the constructor and polymorphic `isInstance()` without a separate
identity mechanism. All RAG-owned errors use this class. Shared core validation
failures retain their code/details and original exception as cause. External
filesystem, decoding, network and parser exceptions remain unchanged. Source
classification is preserved independently of inheritance: HTTP response errors
have source `provider`; ordinary RAG validation/cancellation defaults to `tessar`.

### Sources and extraction rules

Accept exactly one source variant: path, HTTP(S) URL, text with optional MIME, or
Uint8Array with required MIME. Do not infer whether a bare string is a URL or text.
Default text MIME is text/plain. Strip MIME parameters and normalize case.
Decode textual bytes as UTF-8, reporting invalid encoding. File types come from
extensions. HTTP Content-Type wins; absent/octet-stream may use the final URL
extension. Unknown explicit MIME types fail. Use native fetch and filesystem I/O;
HTTP non-success responses reject with status details. Cancel supported I/O and
response-body reads, release responses/resources and recheck after extraction.

| Format | MIME | Output |
| --- | --- | --- |
| TXT | text/plain | text |
| MD/Markdown | text/markdown, text/x-markdown | preserved markdown |
| HTML/HTM | text/html, application/xhtml+xml | markdown via node-html-markdown |
| JSON | application/json, text/json | validated, original text retained |
| CSV | text/csv, application/csv | Markdown table via csv-parse |
| PDF | application/pdf | native text per actual page via PDF.js |
| DOCX | application/vnd.openxmlformats-officedocument.wordprocessingml.document | plain text via mammoth |
| XLSX | application/vnd.openxmlformats-officedocument.spreadsheetml.sheet | text per sheet via read-excel-file |

File extensions: txt, md, markdown, html, htm, json, csv, pdf, docx, xlsx.
No OCR, learned layout/table analysis or VLM. Keep empty native PDF pages when
other pages contain text; all-empty PDFs reject `ExtractionUnavailable`. DOCX
plain-text extraction does not promise headings or reconstructed tables. XLSX
sheet names appear in the text, dates use ISO strings, and formulas use cached
values. Do not insert parser-specific fields into caller metadata.

File provenance is an absolute file URL; HTTP provenance uses the final response
URL. Page numbers are 1-based and emitted only for actual PDF pages. Ordinary
text/Markdown/HTML have no pages. `format` describes the returned text. Do not
truncate or convert extraction failures into successful empty results.

## Document splitting — implemented

The class name is `DocumentSplitter`. Selected strategies are `character`,
`recursive`, `sentence` and `markdown`. They describe splitting boundaries;
measurement is a separate concern. No model-based splitting is selected.

### Agreed units and tokenizer

- Units are `characters` and `tokens`; the default unit is `characters`.
- `maxSize` and `overlap` use the same selected unit.
- Token measurement requires an explicitly supplied tokenizer. Do not infer it
  from an Agent or assume one tokenizer is accurate for every model.
- The application selects a tokenizer compatible with the destination model.
  For chunks destined for embeddings, that is the embedding model, which may
  differ from the chat model. Multiple models may share an encoding/library.
- The tokenizer contract is synchronous and local:

```ts
interface Tokenizer {
  count(text: string): number;
}
```

`count` returns a deterministic, finite, nonnegative integer for the supplied
text. Developers can adapt an existing library using its encode result length.
Do not estimate model tokens by a fixed character ratio, call a model to count,
or require token IDs/decoding in the public contract. Preserve source text when
splitting. Character splitting must not corrupt Unicode characters; precise
character-count and offset semantics will be settled with the output contract.

### Agreed splitting algorithms

Developers choose the strategy and numerical parameters; Tessar is responsible
for implementing the selected algorithm correctly. Parameter tuning guidance is
not a substitute for defining the actual splitting behavior.

| Strategy | Processing |
| --- | --- |
| character | Consecutive bounded text windows with Unicode-safe boundaries; no sentence or semantic analysis. |
| recursive | Prefer paragraph, line, word and finally character boundaries. Recursively subdivide oversized pieces, then combine adjacent pieces within the selected budget. |
| sentence | Detect sentence boundaries and combine whole sentences within the budget. Subdivide an oversized sentence using smaller boundaries; do not identify sentences with a plain period split. |
| markdown | Recognize headings, paragraphs, lists, fenced code and tables before subdividing oversized blocks. A heading marker inside a code fence is not a heading. |

Prefer native `Intl.Segmenter` for sentence detection if its behavior meets the
required cases. Markdown requires structural parsing rather than a heading-only
regular expression. The concrete dependency choice remains open; this approval
does not add LangChain, LlamaIndex or Docling as runtime dependencies.

Implementation checks must cover content preservation, ordering, Unicode safety,
oversized indivisible pieces and termination. For token units, measure the whole
assembled candidate with `Tokenizer.count`; do not assume token counts of separate
pieces are additive. Exact overflow and overlap policies remain to be agreed.

### Algorithm references and evidence

- [LangChain recursive splitter](https://docs.langchain.com/oss/javascript/integrations/splitters/recursive_text_splitter)
  and its [TypeScript implementation](https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain-textsplitters/src/text_splitter.ts)
  provide a reference for recursive boundary selection and merging.
- [LlamaIndex SentenceSplitter implementation](https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/node_parser/text/sentence.py)
  provides a reference for sentence-first splitting with progressively smaller
  fallback boundaries.
- [Docling chunking](https://docling-project.github.io/docling/concepts/chunking/)
  informs structure-first, budget-aware splitting. Its native chunkers require
  a richer DoclingDocument; Tessar's current Content is not equivalent.
- [ECMAScript Intl.Segmenter](https://tc39.es/ecma402/#segmenter-objects)
  is the native sentence-boundary API to assess before adding a dependency.
- [Chroma's chunking evaluation](https://www.trychroma.com/research/evaluating-chunking)
  provides empirical comparisons, including recursive splitting. Results are
  specific to the evaluated setup, not a universal quality guarantee.
- [Is Semantic Chunking Worth the Computational Cost? — NAACL 2025](https://aclanthology.org/2025.findings-naacl.114/)
  reports inconsistent gains relative to semantic chunking's cost. No automatic
  embedding or LLM calls are added to this increment.

### Agreed chunk input and output

`DocumentSplitter.chunk()` accepts one `Content` or a readonly list of `Content`
and returns a list of chunks. Reader results can be passed directly; applications
may also construct Content themselves and use the splitter independently.

Each chunk carries its own `text`, and retains the originating Content's `format`,
`source` and caller `metadata`. Process each Content independently and preserve
input and chunk order. Never combine material from separate Content items into
one chunk. This also keeps the reader's per-page provenance meaningful.

```ts
interface Chunk extends Content {
  position: { contentIndex: number; start: number; end: number };
}
```

`contentIndex` is the zero-based index in the supplied list (0 for a single
Content). `start` and exclusive `end` are UTF-16 offsets in that Content's text:
`chunk.text === original.text.slice(start, end)`. Chunk text is never rewritten,
trimmed, enriched or given repeated headings/table headers. No chunk ID is
generated. The application can assign storage identities downstream.

`source.page` is the actual one-based page containing the text, not a total page
count. DocumentReader emits one Content per PDF page, and independent splitting
means these chunks never span PDF pages. Inline text/Markdown has no invented
page. Page provenance remains in source, not duplicated inside position.

Each chunk receives an independent JSON copy of the original metadata and source.
Mutating one output must not mutate input or sibling chunks. Framework provenance
stays outside caller metadata.

### Agreed configuration and execution

```ts
const splitter = new DocumentSplitter({
  strategy: "recursive",
  maxSize: 1000,
  overlap: 100,
  unit: "characters",
});

const chunks = splitter.chunk(contents);
```

The numbers above illustrate configuration, not recommended quality settings.
`strategy` and `maxSize` are required. `overlap` defaults to 0 and `unit` defaults
to `characters`. `tokenizer` is required for `unit: "tokens"`.

`chunk()` returns `Chunk[]` synchronously. Splitting and the supplied tokenizer
are local synchronous work; this API does not create an asynchronous task or
expose a task ID, result Promise or cancellation handle. Applications can move
large workloads to a worker. This does not change DocumentReader's I/O task API.

### Agreed validation and boundary behavior

- `maxSize` is a positive safe integer; `overlap` is a nonnegative safe integer
  strictly less than maxSize. Invalid configuration throws TessarRagError.
- Character units count Unicode code points. UTF-16 positions remain compatible
  with String.slice and must not split a surrogate pair.
- Empty input lists and empty Content text produce no chunks. Preserve all
  original whitespace in nonempty input, including blank lines and CRLF.
- Overlap is a maximum target at the selected strategy's boundaries. It may be
  smaller to preserve boundaries or make room for new material. Every emitted
  chunk advances to new source content; never emit overlap-only duplicates.
- A sentence/block exceeding maxSize is subdivided using smaller boundaries.
  An indivisible code point exceeding a token budget throws TessarRagError;
  do not silently exceed the limit or recurse forever.
- Oversized Markdown tables and code blocks may be split. Such fragments may
  not be standalone valid Markdown; preservation and the hard budget take
  precedence over injecting formatting not present in the source.
- Tokenizer counts must be finite nonnegative safe integers; invalid counts
  throw TessarRagError. Exceptions thrown by the tokenizer remain unchanged.

Implementation choice: use markdown-it's block tokens and line maps to recognize
Markdown structure while slicing original text, including original line endings.
Use native Intl.Segmenter sentence detection. These are private implementation
details, not public parser/strategy registries. No other RAG pipeline is added.

## Embedding — common contract implemented

The embedding module will live in `packages/rag/src/embedding`, shared by
ingestion and retrieval. Use separate public `embedDocuments()` and `embedQuery()`
methods. This supersedes the earlier single-method decision: document/query
purpose is expressed by the method, not a caller-supplied generic purpose field.

The approved minimal contract is:

```ts
interface EmbeddingModel {
  embedDocuments(input: readonly (string | { text: string })[]): Promise<number[][]>;
  embedQuery(input: string): Promise<number[]>;
}
```

Document results preserve input order; the query method returns one vector.
Document inputs may be raw strings or objects with text, including Content and
Chunk. Read each object's text internally without sending metadata/source or
other fields to the provider. Preserve existing string-array support; no caller
map is required. Each input element remains one embedding unit: no automatic
loading, chunking, joining or page-number interpretation.
Publish this type-only contract from src/embedding/types.ts through the package
root. No forwarding class or extra runtime export is required for this increment.

Adapters support a documented provider/model scope, not automatic universal
model recognition. They own document/query mapping and provider-specific
configuration. Models using the same API may work with a different model ID,
but task parameters/instructions are not inferred correctly for every model.
Adapters can expose optional configuration overrides; fundamentally different
behavior can use an application-defined implementation of EmbeddingModel.
The common RAG contract does not enumerate native input_type/taskType values or
silently add provider-specific fields/prefixes.

Scope for this increment is the common contract, public type checks and usage
documentation. Provider classes, concrete override field names, batching, retry,
timeout, cancellation and other adapter configuration require their own agreed
design. They are not added by implementing these two type signatures.

## OpenAI embedding adapter — implemented

Add OpenAIEmbedding to @tessar/openai, structurally compatible with the shared
EmbeddingModel contract. Do not add an @tessar/rag dependency to the provider.
One flat constructor requires model and accepts official OpenAI SDK ClientOptions
plus native embeddings request options excluding input: dimensions, user and
encoding_format. Reuse the existing client configuration key list/client factory.
Keep settings private; export the class and OpenAIEmbeddingOptions only.

embedDocuments(readonly (string | {text:string})[]) returns Promise<number[][]> in input order;
embedQuery(string) returns Promise<number[]>. Both call client.embeddings.create,
with no document/query task field or instruction prefix. No Agent, Controller,
Session, initialization, registration or forwarding class is required.

Only explicitly supplied constructor fields are forwarded by Tessar. The SDK
retains its own defaults (including its automatic base64 transport/decoding).
If encoding_format is explicitly base64, decode the response to numeric vectors.
Native OpenAI SDK errors, retries and timeouts remain SDK-owned and unchanged.
No additional retry loop, implicit batching, model catalog or model inference.

Implementation rulings: snapshot JSON request configuration and each input array;
extract and snapshot the text from rich document objects before asynchronous I/O.
an empty document list returns [] without a request. Reject wrong runtime input
types with TessarError. Provider responses must have one nonempty finite numeric
vector per input, consistent vector sizes, and unique in-range integer indices;
reorder by response index. Malformed response failures use TessarError with source
provider, while existing SDK exceptions propagate unchanged. These checks do not
add new public fields or enforce a catalog of model-specific dimensions.

Document the SDK defaults separately from Tessar defaults. Keep existing package
versions, make no publications, and preserve chat-provider behavior.

## Scope beyond these increments

Other RAG APIs and any public adapter-registration contract remain unapproved.
Extend this specification and its companion plan after agreeing those APIs;
do not add them merely because a typical pipeline contains them.
