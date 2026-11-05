import { NodeHtmlMarkdown } from "node-html-markdown";
import { parse } from "csv-parse/sync";
import { fail } from "@tessar/core";
import type { ExtractedContent } from "./binary.js";
import { MIME_TYPE, type LoadedSource } from "./source.js";

const BINARY_MIME_TYPES: readonly string[] = [MIME_TYPE.PDF, MIME_TYPE.DOCX, MIME_TYPE.XLSX];

function cell(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}

export async function extract(
  source: LoadedSource,
  signal: AbortSignal,
): Promise<ExtractedContent[]> {
  signal.throwIfAborted();
  const { data, mimeType, uri } = source;
  if (
    BINARY_MIME_TYPES.includes(mimeType)
  ) {
    if (typeof data === "string")
      fail("InvalidData", "Binary document formats require byte data");
    const { extractBinary } = await import("./binary.js");
    signal.throwIfAborted();
    return extractBinary(data, mimeType, signal, uri);
  }
  const text =
    typeof data === "string"
      ? data
      : new TextDecoder("utf-8", { fatal: true }).decode(data);
  let result = text;
  let format: "text" | "markdown" =
    mimeType === MIME_TYPE.MARKDOWN ? "markdown" : "text";
  if (mimeType === MIME_TYPE.JSON) JSON.parse(text);
  if (mimeType === MIME_TYPE.HTML) {
    result = NodeHtmlMarkdown.translate(text);
    format = "markdown";
  }
  if (mimeType === MIME_TYPE.CSV) {
    const rows = parse(text, {
      bom: true,
      skip_empty_lines: true,
    }) as string[][];
    if (rows.length) {
      const lines = rows.map((row) => "| " + row.map(cell).join(" | ") + " |");
      lines.splice(1, 0, "| " + rows[0]!.map(() => "---").join(" | ") + " |");
      result = lines.join("\n");
    }
    format = "markdown";
  }
  signal.throwIfAborted();
  return [
    { text: result, format, ...(uri === undefined ? {} : { source: { uri } }) },
  ];
}
