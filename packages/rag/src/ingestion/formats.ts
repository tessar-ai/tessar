import { NodeHtmlMarkdown } from "node-html-markdown";
import { parse } from "csv-parse/sync";
import { fail } from "@tessar/core";
import type { ExtractedContent } from "./binary.js";
import type { LoadedSource } from "./source.js";

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
    [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ].includes(mimeType)
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
    mimeType === "text/markdown" ? "markdown" : "text";
  if (mimeType === "application/json") JSON.parse(text);
  if (mimeType === "text/html") {
    result = NodeHtmlMarkdown.translate(text);
    format = "markdown";
  }
  if (mimeType === "text/csv") {
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
