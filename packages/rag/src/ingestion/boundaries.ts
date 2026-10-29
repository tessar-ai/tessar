import MarkdownIt from "markdown-it";

export interface Span {
  start: number;
  end: number;
}

const sentenceSegmenter = new Intl.Segmenter(undefined, {
  granularity: "sentence",
});
const markdown = new MarkdownIt();
const separators = [
  /(?:\r\n|\r|\n)[\t ]*(?:\r\n|\r|\n)/gu,
  /\r\n|[\r\n]/gu,
  /[^\S\r\n]+/gu,
];

/** Keep separators on their preceding piece so every byte of source survives. */
export function recursiveParts(
  text: string,
  span: Span,
  level: number,
): Span[] {
  const separator = separators[level];
  if (!separator) return codePoints(text, span);
  const ends = Array.from(
    text.slice(span.start, span.end).matchAll(separator),
    (match) => span.start + match.index + match[0].length,
  );
  return ranges(span.start, span.end, ends);
}

export function codePoints(text: string, span: Span): Span[] {
  const result: Span[] = [];
  for (let start = span.start; start < span.end; ) {
    const end = start + (text.codePointAt(start)! > 0xffff ? 2 : 1);
    result.push({ start, end });
    start = end;
  }
  return result;
}

export function sentences(text: string): Span[] {
  return Array.from(sentenceSegmenter.segment(text), (part) => ({
    start: part.index,
    end: part.index + part.segment.length,
  }));
}

export function markdownBlocks(text: string): Span[] {
  const lines = [0];
  for (const match of text.matchAll(/\r\n|[\r\n]/g))
    lines.push(match.index + match[0].length);
  const blocks = markdown
    .parse(text, {})
    .filter((token) => token.level === 0 && token.map);
  const ends: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    // Attach headings to their following block instead of orphaning a heading.
    if (blocks[i]!.type === "heading_open" && i + 1 < blocks.length) continue;
    const next = blocks[i + 1];
    ends.push(next ? lines[next.map![0]]! : text.length);
  }
  return ranges(0, text.length, ends);
}

function ranges(start: number, end: number, ends: number[]): Span[] {
  const result: Span[] = [];
  for (const boundary of ends) {
    if (boundary > start && boundary <= end) {
      result.push({ start, end: boundary });
      start = boundary;
    }
  }
  if (start < end) result.push({ start, end });
  return result;
}
