import { TessarRagError } from "../errors.js";

export type ExtractedContent = {
  text: string;
  format: "text" | "markdown";
  source?: { uri?: string; page?: number };
};

/** Ordinary text extraction only; no OCR, document layout analysis or models. */
export async function extractBinary(
  data: Uint8Array,
  mimeType: string,
  signal: AbortSignal,
  uri?: string,
): Promise<ExtractedContent[]> {
  signal.throwIfAborted();
  try {
    if (mimeType === "application/pdf") {
      const result = await extractPdf(data, signal, uri);
      signal.throwIfAborted();
      return result;
    }
    const source = uri === undefined ? undefined : { uri };
    if (
      mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const { default: mammoth } = await import("mammoth");
      signal.throwIfAborted();
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(data),
      });
      signal.throwIfAborted();
      return [
        { text: result.value, format: "text", ...(source ? { source } : {}) },
      ];
    }
    if (
      mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      const { default: readXlsxFile } = await import("read-excel-file/node");
      signal.throwIfAborted();
      const sheets = await readXlsxFile(Buffer.from(data), { trim: false });
      signal.throwIfAborted();
      return sheets.map(({ sheet, data: rows }) => ({
        text: `Sheet: ${sheet}\n${rows.map((row) => row.map(cellText).join("\t")).join("\n")}`,
        format: "text",
        ...(source ? { source } : {}),
      }));
    }
    throw new TessarRagError(
      "ExtractionUnavailable",
      `Unsupported binary content type: ${mimeType}`,
    );
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

async function extractPdf(
  data: Uint8Array,
  signal: AbortSignal,
  uri?: string,
): Promise<ExtractedContent[]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  signal.throwIfAborted();
  // PDF.js may transfer ownership of data; keep the caller's bytes intact.
  const task = getDocument({
    data: new Uint8Array(data),
    useSystemFonts: true,
  });
  let cleanup: Promise<void> | undefined;
  const destroy = () => (cleanup ??= task.destroy());
  const onAbort = () => {
    void destroy().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  let failed = false;
  try {
    const document = await task.promise;
    signal.throwIfAborted();
    const result: ExtractedContent[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      signal.throwIfAborted();
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        signal.throwIfAborted();
        const text = content.items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "",
          )
          .join("")
          .trim();
        result.push({
          text,
          format: "text",
          source: { ...(uri === undefined ? {} : { uri }), page: pageNumber },
        });
      } finally {
        page.cleanup();
      }
    }
    if (!result.some(({ text }) => text.trim()))
      throw new TessarRagError(
        "ExtractionUnavailable",
        "PDF contains no extractable text layer; OCR is not supported.",
      );
    return result;
  } catch (error) {
    failed = true;
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Cleanup must not replace the parser's original error or abort reason.
    try {
      await destroy();
    } catch (error) {
      if (!failed && !signal.aborted) throw error;
    }
  }
}
