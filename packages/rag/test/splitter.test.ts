import { expect, it } from "vitest";
import * as rag from "../src/index.js";
import type { Content } from "../src/index.js";
import { pdfFixture } from "./fixtures.js";

const content = (text: string, format: Content["format"] = "text"): Content => ({
  text, format, metadata: {},
});

it("exports a standalone synchronous DocumentSplitter", () => {
  expect(typeof rag.DocumentSplitter).toBe("function");
  const splitter = new rag.DocumentSplitter({ strategy: "character", maxSize: 3 });
  const chunks = splitter.chunk(content("abcdef"));
  expect(chunks.map(chunk => chunk.text)).toEqual(["abc", "def"]);
  expect(chunks).not.toBeInstanceOf(Promise);
  expect(chunks[0]).toEqual({
    text: "abc", format: "text", metadata: {},
    position: { contentIndex: 0, start: 0, end: 3 },
  });
});

it("counts code points while returning exact UTF-16 positions and overlap", () => {
  const original = content("A😀BC😀D");
  const chunks = new rag.DocumentSplitter({
    strategy: "character", maxSize: 3, overlap: 1,
  }).chunk(original);
  expect(chunks.map(chunk => chunk.text)).toEqual(["A😀B", "BC😀", "😀D"]);
  expect(chunks.map(chunk => chunk.position)).toEqual([
    { contentIndex: 0, start: 0, end: 4 },
    { contentIndex: 0, start: 3, end: 7 },
    { contentIndex: 0, start: 5, end: 8 },
  ]);
  for (const chunk of chunks) {
    expect(chunk.text).toBe(original.text.slice(chunk.position.start, chunk.position.end));
    expect(chunk.text.isWellFormed()).toBe(true);
  }
});

it("retains page provenance and independent metadata copies for each input", () => {
  const source = { uri: "file:///manual.pdf", page: 3 };
  const metadata = { tenant: "a", nested: { revision: 1 } };
  const original: Content = { ...content("abcdef"), source, metadata };
  const chunks = new rag.DocumentSplitter({ strategy: "character", maxSize: 3 })
    .chunk([content(""), original, { ...content("xyz"), source: { page: 4 } }]);
  expect(chunks.map(chunk => chunk.position.contentIndex)).toEqual([1, 1, 2]);
  expect(chunks.map(chunk => chunk.source?.page)).toEqual([3, 3, 4]);
  expect(chunks[0]!.source).toEqual(source);
  expect(chunks[0]!.metadata).toEqual(metadata);
  expect(chunks[0]!.metadata).not.toBe(metadata);
  expect(chunks[0]!.metadata.nested).not.toBe(chunks[1]!.metadata.nested);
  (chunks[0]!.metadata as typeof metadata).nested.revision = 2;
  chunks[0]!.source!.page = 99;
  expect(metadata.nested.revision).toBe(1);
  expect(chunks[1]!.metadata).toEqual(metadata);
  expect(source.page).toBe(3);
  expect(chunks[1]!.source?.page).toBe(3);
});

it("preserves blank content and returns no chunks for empty input", () => {
  const splitter = new rag.DocumentSplitter({ strategy: "recursive", maxSize: 2 });
  expect(splitter.chunk([])).toEqual([]);
  expect(splitter.chunk(content(""))).toEqual([]);
  expect(splitter.chunk(content(" \n \t")).map(chunk => chunk.text).join(""))
    .toBe(" \n \t");
});

it.each([
  {}, { strategy: "missing", maxSize: 2 }, { strategy: "recursive" },
  { maxSize: 0 }, { maxSize: -1 }, { maxSize: 1.5 }, { maxSize: Infinity },
  { maxSize: Number.MAX_SAFE_INTEGER + 1 }, { overlap: -1 }, { overlap: 2 },
  { overlap: 0.5 }, { unit: "words" }, { unit: "tokens" },
  { overlap: null }, { unit: null },
  { unit: "tokens", tokenizer: {} }, { unknown: true },
])("rejects invalid splitter configuration: %j", overrides => {
  const options = "strategy" in overrides || Object.keys(overrides).length === 0
    ? overrides
    : { strategy: "recursive", maxSize: 2, ...overrides };
  expect(() => new rag.DocumentSplitter(options as never)).toThrow(rag.TessarRagError);
});

it.each([
  null, "text", {}, { text: 1, format: "text", metadata: {} },
  { text: "x", format: "html", metadata: {} },
  { text: "x", format: "text", metadata: null },
  { text: "x", format: "text", metadata: { value: undefined } },
  { text: "x", format: "text", source: { page: 0 }, metadata: {} },
])("rejects invalid Content data: %j", input => {
  const splitter = new rag.DocumentSplitter({ strategy: "character", maxSize: 2 });
  expect(() => splitter.chunk(input as never)).toThrow(rag.TessarRagError);
});

it("snapshots configuration and retains a tokenizer's method receiver", () => {
  class Counter {
    multiplier = 2;
    count(text: string) { return Array.from(text).length * this.multiplier; }
  }
  const options = { strategy: "character" as const, maxSize: 4, unit: "tokens" as const, tokenizer: new Counter() };
  const splitter = new rag.DocumentSplitter(options);
  options.maxSize = 100;
  expect(splitter.chunk(content("abcde")).map(chunk => chunk.text)).toEqual(["ab", "cd", "e"]);
});

it("measures complete candidates instead of assuming additive token counts", () => {
  const tokenizer = { count: (text: string) => text.length + (text.match(/ /g)?.length ?? 0) * 2 };
  const chunks = new rag.DocumentSplitter({
    strategy: "character", maxSize: 4, overlap: 1, unit: "tokens", tokenizer,
  }).chunk(content("ab cd ef"));
  expect(chunks.map(chunk => chunk.text)).not.toEqual(["ab c", "cd e", "ef"]);
  expect(chunks.every(chunk => tokenizer.count(chunk.text) <= 4)).toBe(true);
  let covered = 0;
  for (const chunk of chunks) {
    expect(chunk.position.start).toBeLessThanOrEqual(covered);
    expect(chunk.position.end).toBeGreaterThan(covered);
    covered = chunk.position.end;
  }
  expect(covered).toBe(8);
});

it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])(
  "rejects invalid tokenizer counts: %s", count => {
    const splitter = new rag.DocumentSplitter({
      strategy: "character", maxSize: 3, unit: "tokens",
      tokenizer: { count: () => count } as never,
    });
    expect(() => splitter.chunk(content("abc"))).toThrow(rag.TessarRagError);
  },
);

it("preserves tokenizer errors and reports an indivisible oversized code point", () => {
  const error = new TypeError("custom tokenizer failure");
  const splitter = new rag.DocumentSplitter({
    strategy: "recursive", maxSize: 1, unit: "tokens",
    tokenizer: { count: () => { throw error; } },
  });
  let caught: unknown;
  try { splitter.chunk(content("x")); } catch (failure) { caught = failure; }
  expect(caught).toBe(error);
  for (const strategy of ["character", "recursive", "sentence", "markdown"] as const) {
    const splitter = new rag.DocumentSplitter({
      strategy, maxSize: 1, unit: "tokens", tokenizer: { count: text => text.length },
    });
    expect(() => splitter.chunk(content("😀"))).toThrow(rag.TessarRagError);
  }
});

it("prefers paragraphs, then lines and words before falling back to characters", () => {
  const splitter = new rag.DocumentSplitter({ strategy: "recursive", maxSize: 9 });
  const text = "Alpha.\n\nBeta.\n\n0123456789abcdefgh ij kl\nNext";
  const chunks = splitter.chunk(content(text));
  expect(chunks[0]!.text).toBe("Alpha.\n\n");
  expect(chunks[1]!.text).toBe("Beta.\n\n");
  expect(chunks.map(chunk => chunk.text).join("")).toBe(text);
  expect(chunks.every(chunk => Array.from(chunk.text).length <= 9)).toBe(true);
});

it("packs whole sentences and preserves a decimal number", () => {
  const text = "Value is 3.14. Next sentence. Last sentence.";
  const chunks = new rag.DocumentSplitter({ strategy: "sentence", maxSize: 30 })
    .chunk(content(text));
  expect(chunks.map(chunk => chunk.text)).toEqual([
    "Value is 3.14. Next sentence. ", "Last sentence.",
  ]);
  const long = "One sentence that is far too long for the budget.";
  const split = new rag.DocumentSplitter({ strategy: "sentence", maxSize: 12 }).chunk(content(long));
  expect(split.map(chunk => chunk.text).join("")).toBe(long);
  expect(split.every(chunk => Array.from(chunk.text).length <= 12)).toBe(true);
});

it("keeps overlap at sentence boundaries and always makes forward progress", () => {
  const chunks = new rag.DocumentSplitter({ strategy: "sentence", maxSize: 12, overlap: 6 })
    .chunk(content("One. Two. Three. Four."));
  expect(chunks.map(chunk => chunk.text)).toEqual(["One. Two. ", "Two. Three. ", "Four."]);
});

it("uses Markdown blocks, preserving fences with fake headings, tables and lists", () => {
  const fence = "~~~ts\n# not a heading\nconst x=1;\n~~~\n\n";
  const table = "| A | B |\n| - | - |\n| 1 | 2 |\n\n";
  const list = "- first\n- second\n\n";
  const text = "# Guide\n\nIntro.\n\n" + fence + table + list + "## Next\n\nFinal.\n";
  const chunks = new rag.DocumentSplitter({ strategy: "markdown", maxSize: fence.length })
    .chunk(content(text, "markdown"));
  expect(chunks.some(chunk => chunk.text.includes(fence))).toBe(true);
  expect(chunks.some(chunk => chunk.text.includes(table))).toBe(true);
  expect(chunks.some(chunk => chunk.text.includes(list))).toBe(true);
  expect(chunks.some(chunk => chunk.text.includes("## Next\n\nFinal."))).toBe(true);
  expect(chunks.map(chunk => chunk.text).join("")).toBe(text);
});

it.each(["character", "recursive", "sentence", "markdown"] as const)(
  "%s preserves source slices and budgets with CRLF, Unicode and high overlap", strategy => {
    const text = "# Title\r\n\r\nXin chào 😀. Tiếp tục.\r\n\r\n```ts\r\n# fake\r\n01234567890123456789\r\n```\r\n\r\n| A |\r\n| - |\r\n| B |\r\n";
    for (const overlap of [0, 3, 10]) {
      const chunks = new rag.DocumentSplitter({ strategy, maxSize: 11, overlap }).chunk(content(text, "markdown"));
      let end = 0;
      for (const chunk of chunks) {
        expect(chunk.text).toBe(text.slice(chunk.position.start, chunk.position.end));
        expect(chunk.text.isWellFormed()).toBe(true);
        expect(Array.from(chunk.text).length).toBeLessThanOrEqual(11);
        expect(chunk.position.start).toBeLessThanOrEqual(end);
        expect(chunk.position.end).toBeGreaterThan(end);
        if (overlap === 0) expect(chunk.position.start).toBe(end);
        expect(Array.from(text.slice(chunk.position.start, end)).length).toBeLessThanOrEqual(overlap);
        end = chunk.position.end;
      }
      expect(end).toBe(text.length);
      if (overlap === 0) expect(chunks.map(chunk => chunk.text).join("")).toBe(text);
    }
  },
);

it("passes actual PDF page Content directly from reader to splitter", async () => {
  const contents = await new rag.DocumentReader().load({
    source: { data: pdfFixture(["First page text", "Second page text", "Third page text"]), mimeType: "application/pdf" },
  }, { metadata: { tenant: "a" } }).result();
  const chunks = new rag.DocumentSplitter({ strategy: "recursive", maxSize: 8 }).chunk(contents);
  expect(new Set(chunks.map(chunk => chunk.source?.page))).toEqual(new Set([1, 2, 3]));
  for (const chunk of chunks) {
    const original = contents[chunk.position.contentIndex]!;
    expect(chunk.source).toEqual(original.source);
    expect(chunk.text).toBe(original.text.slice(chunk.position.start, chunk.position.end));
    expect(chunk.metadata).toEqual({ tenant: "a" });
  }
});

it.each(["character", "recursive", "sentence", "markdown"] as const)(
  "%s enforces exact token budgets for structured inputs", strategy => {
    const text = "# One\r\n\r\nAlpha beta 😀. More text.\r\n\r\n- item one\r\n- item two\r\n\r\n## Two\r\n\r\nFinal text.";
    const tokenizer = { count: (value: string) => Array.from(value).length + (value.match(/\s/g)?.length ?? 0) };
    const chunks = new rag.DocumentSplitter({ strategy, maxSize: 20, overlap: 7, unit: "tokens", tokenizer })
      .chunk(content(text, "markdown"));
    let end = 0;
    for (const chunk of chunks) {
      expect(tokenizer.count(chunk.text)).toBeLessThanOrEqual(20);
      expect(chunk.position.start).toBeLessThanOrEqual(end);
      expect(chunk.position.end).toBeGreaterThan(end);
      expect(tokenizer.count(text.slice(chunk.position.start, end))).toBeLessThanOrEqual(7);
      end = chunk.position.end;
    }
    expect(end).toBe(text.length);
  },
);

it("handles large input at the minimum chunk budget", () => {
  const chunks = new rag.DocumentSplitter({ strategy: "recursive", maxSize: 1 })
    .chunk(content("x".repeat(350000)));
  expect(chunks.length).toBe(350000);
  expect(chunks.at(-1)!.position.end).toBe(350000);
});
