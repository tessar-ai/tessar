import { TessarRagError } from "../errors.js";
import {
  codePoints,
  markdownBlocks,
  recursiveParts,
  sentences,
  type Span,
} from "./boundaries.js";
import type { SplitStrategy } from "./types.js";

type Measure = (start: number, end: number) => number;

/** Code-point prefix counts keep character-budget checks constant-time. */
export function characterMeasure(text: string): Measure {
  const counts = new Uint32Array(text.length + 1);
  let count = 0;
  for (let offset = 0; offset < text.length; ) {
    const width = text.codePointAt(offset)! > 0xffff ? 2 : 1;
    if (width === 2) counts[offset + 1] = count;
    offset += width;
    counts[offset] = ++count;
  }
  return (start, end) => counts[end]! - counts[start]!;
}

export function chunkSpans(
  text: string,
  strategy: SplitStrategy,
  maxSize: number,
  overlap: number,
  measure: Measure,
): Span[] {
  if (!text) return [];
  const whole = { start: 0, end: text.length };
  if (measure(0, text.length) <= maxSize) return [whole];

  function refine(span: Span, level = 0): Span[] {
    if (measure(span.start, span.end) <= maxSize) return [span];
    if (level === 3) {
      const points = codePoints(text, span);
      for (const point of points) {
        if (measure(point.start, point.end) > maxSize)
          throw new TessarRagError(
            "InvalidConfiguration",
            "A single Unicode code point exceeds maxSize",
          );
      }
      return pack(points, maxSize, overlap, measure);
    }
    return group(recursiveParts(text, span, level), level + 1);
  }

  function group(parts: Span[], level = 0): Span[] {
    const result: Span[][] = [];
    let pending: Span[] = [];
    for (const part of parts) {
      if (measure(part.start, part.end) <= maxSize) pending.push(part);
      else {
        result.push(pack(pending, maxSize, overlap, measure));
        pending = [];
        result.push(refine(part, level));
      }
    }
    result.push(pack(pending, maxSize, overlap, measure));
    return result.flat();
  }

  return strategy === "character"
    ? refine(whole, 3)
    : strategy === "sentence"
      ? group(sentences(text))
      : strategy === "markdown"
        ? group(markdownBlocks(text))
        : refine(whole);
}

function pack(
  units: Span[],
  maxSize: number,
  overlap: number,
  measure: Measure,
): Span[] {
  if (!units.length) return [];
  const chunks: Span[] = [];
  let first = 0;
  let next = 0;
  while (next < units.length) {
    if (measure(units[first]!.start, units[next]!.end) <= maxSize) {
      next++;
      continue;
    }
    const end = units[next - 1]!.end;
    chunks.push({ start: units[first]!.start, end });
    let retained = next;
    while (
      retained > first &&
      measure(units[retained - 1]!.start, end) <= overlap
    )
      retained--;
    // Reduce retained overlap until at least the next new unit fits.
    while (
      retained < next &&
      measure(units[retained]!.start, units[next]!.end) > maxSize
    )
      retained++;
    first = retained;
  }
  chunks.push({ start: units[first]!.start, end: units[next - 1]!.end });
  return chunks;
}
