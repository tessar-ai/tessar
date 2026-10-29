import { expect, it } from "vitest";
import { DocumentReader, DocumentSplitter, type ReadTask, type Content, type Chunk, type SplitOptions, type Tokenizer } from "../src/index.js";
import type { EmbeddingModel } from "../src/index.js";

if (false) {
  const model = {} as EmbeddingModel;
  const documents: Promise<number[][]> = model.embedDocuments(["first", "second"] as const);
  const query: Promise<number[]> = model.embedQuery("question");
  const contents: Content[] = [{ text: "page content", format: "text", source: { page: 3 }, metadata: {} }];
  const chunks: Chunk[] = [{ ...contents[0]!, position: { contentIndex: 0, start: 0, end: 12 } }];
  model.embedDocuments(contents);
  model.embedDocuments(chunks);
  model.embedDocuments(["raw", ...contents, ...chunks]);
  // @ts-expect-error document objects must have string text
  model.embedDocuments([{ text: 123 }]);
  // @ts-expect-error documents accept an array, not a single text
  model.embedDocuments("text");
  // @ts-expect-error a query accepts one text, not an array
  model.embedQuery(["question"]);
  // @ts-expect-error document/query methods supersede the generic embed method
  model.embed("text");
  // @ts-expect-error the shared contract has no native provider options
  model.embedQuery("question", { input_type: "search_query" });
  void documents;
  void query;
}

it("exposes one object-input signature and method-based control", () => {
  expect(typeof DocumentReader).toBe("function");
  if (false) {
    const reader = new DocumentReader();
    const task: ReadTask = reader.load({ id: "one", source: { text: "hello" } });
    const result: Promise<Content[]> = task.result();
    task.cancel("Cancel");
    // @ts-expect-error no positional ID overload
    reader.load("one", { text: "hello" });
    // @ts-expect-error source must be under the input object
    reader.load({ text: "hello" });
    // @ts-expect-error no public cancellation signal option
    reader.load({ source: { text: "hello" } }, { signal: new AbortController().signal });
    // @ts-expect-error identity is readonly
    task.id = "two";
    void result;
  }
});

it("exposes synchronous splitting and requires a tokenizer for token units", () => {
  expect(typeof DocumentSplitter).toBe("function");
  if (false) {
    const tokenizer: Tokenizer = { count: text => text.length };
    const options: SplitOptions = { strategy: "sentence", maxSize: 100, unit: "tokens", tokenizer };
    const splitter = new DocumentSplitter(options);
    const input: Content = { text: "hello", format: "text", metadata: {} };
    const chunks: Chunk[] = splitter.chunk(input);
    const others: Chunk[] = splitter.chunk([input] as const);
    const end: number = chunks[0]!.position.end;
    // @ts-expect-error strategy is required
    new DocumentSplitter({ maxSize: 100 });
    // @ts-expect-error maxSize is required
    new DocumentSplitter({ strategy: "recursive" });
    // @ts-expect-error token measurement requires a tokenizer
    new DocumentSplitter({ strategy: "recursive", maxSize: 100, unit: "tokens" });
    // @ts-expect-error use Content, not a source or a bare string
    splitter.chunk("hello");
    // @ts-expect-error splitting is synchronous, not an operation handle
    chunks.result();
    void others;
    void end;
  }
});
