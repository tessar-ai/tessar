# RAG content reader API

**Status:** API contract agreed on 2026-10-29; implemented in `@tessar/rag`.

The incremental [specification](superpowers/specs/2026-10-29-rag-design.md) and
[implementation plan](superpowers/plans/2026-10-29-rag.md)
cover this reader and will be extended as subsequent RAG APIs are agreed.

Tessar provides independent tools that developers compose themselves. The reader
combines source loading and content extraction in one public operation. It runs
without an Agent, Controller or Session. It does not manage document updates,
persist results, create chunks, embed content or inject agent context.

## Public API

```ts
const reader = new DocumentReader();

const reading = reader.load(
  {
    id: "read-manual",
    source: { path: "D:/docs/manual.pdf" },
  },
  {
    metadata: { project: "cube" },
  },
);

const contents = await reading.result();
```

```ts
interface ReadInput {
  id?: string;
  source: ReadSource;
}

type ReadSource =
  | { path: string }
  | { url: string }
  | { text: string; mimeType?: string }
  | { data: Uint8Array; mimeType: string };

interface ReadOptions {
  metadata?: JsonObject;
}

declare class DocumentReader {
  load(input: ReadInput, options?: ReadOptions): ReadTask;
}

interface ReadTask {
  readonly id: string;
  result(): Promise<Content[]>;
  cancel(reason?: string): void;
}
```

`JsonObject` is Tessar's JSON-compatible object type. Each call accepts exactly
one source variant. Text defaults to `text/plain`; byte input requires a MIME
type. A path is resolved on the machine running the SDK. Paths and URLs are
loaded and extracted through the same public operation.

## Execution identity and cancellation

- `id` is the first field in the input object, alongside `source`. There is one
  call signature: no positional ID, overload or `undefined` placeholder.
- Omitted IDs produce a UUID without a prefix. Supplied IDs must be nonempty;
  concurrent reads on the same Reader cannot share an ID.
- `load()` starts work and immediately returns its handle. The handle's ID
  identifies that execution, not the source document or its output items.
- `result()` awaits the execution. Repeated calls do not repeat the read.
- `cancel()` requests cancellation of that execution. Successful cancellation
  rejects its result; cancelling after completion does not alter the result.
- Cancellation is cooperative. Implementations must propagate the request to
  supported I/O and check it at processing boundaries; arbitrary synchronous
  code cannot be forcibly interrupted by this contract.
- There is no public `signal` option. Cancellation mechanisms are internal.

Applications exposing HTTP or IPC APIs map the execution ID to its handle and
manage routing, access and ID uniqueness across their own processes or retained
results. The reader does not provide a server or a persistent task registry.

## Result

```ts
interface Content {
  text: string;
  format: "text" | "markdown";
  source?: {
    uri?: string;
    page?: number;
  };
  metadata: JsonObject;
}
```

Example result, assuming the reader can identify a PDF page:

```json
[
  {
    "text": "Tessar configuration instructions...",
    "format": "text",
    "source": {
      "uri": "file:///D:/docs/manual.pdf",
      "page": 1
    },
    "metadata": {
      "project": "cube"
    }
  }
]
```

- Always return an array, including for one content item. An item is a unit
  produced by the reader, not necessarily a page or an embedding chunk.
- `format` describes the output string, not the source file type. Markdown is
  reported only when the returned text actually uses that representation.
- Source information is optional and only reported when known. Page numbers
  start at 1 and refer to actual source pages. Ordinary text, Markdown and HTML
  have no fixed pages. Do not invent a page number or assign a single page to
  content spanning multiple pages.
- Preserve caller metadata separately; default to `{}`. Reader provenance must
  not be silently inserted into caller metadata.
- Read/extraction failures and cancellation reject `result()`. Do not disguise
  failures as successful empty results or mix errors into `Content[]`.

## Implementation scope

RAG-owned failures use exported `TessarRagError extends TessarError`, following
the shared class/instance-guard design. It inherits the core constructor and
`isInstance(error: unknown)`. Both the specific guard and the shared parent guard
recognize these failures. Native source/parser exceptions and other sibling
Tessar error subclasses retain their original identity. Source classification
is independent of inheritance; HTTP response failures retain source `provider`.

Start with ordinary extraction. OCR, learned layout/table analysis and VLM
processing are later extensions and must not be invoked implicitly. Input forms
do not imply support for every file format. The supported format matrix and parser
dependencies are documented in the [package README](../packages/rag/README.md).
A public adapter registration API requires a separate design.

