import { afterEach, describe, expect, it, vi } from "vitest";
import { extractBinary } from "../src/ingestion/binary.js";
import { docxFixture, pdfFixture, pdfStreamsFixture, xlsxFixture } from "./fixtures.js";

const signal = () => new AbortController().signal;
const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const pdfSdk = vi.hoisted(() => ({
  tasks: [] as { destroy: () => Promise<void> }[],
  onLoad: undefined as (() => void) | undefined,
}));
// Keep the real parser; observe its resource-owning task at the SDK boundary.
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", async (importOriginal) => {
  const original = await importOriginal<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>();
  return {
    ...original,
    getDocument: (...args: Parameters<typeof original.getDocument>) => {
      const task = original.getDocument(...args);
      vi.spyOn(task, "destroy");
      pdfSdk.tasks.push(task);
      pdfSdk.onLoad?.();
      return task;
    },
  };
});
afterEach(() => {
  pdfSdk.tasks.length = 0;
  pdfSdk.onLoad = undefined;
});

describe("ordinary binary extraction", () => {
  it("extracts each real PDF text page with one-based source pages", async () => {
    const bytes = pdfFixture();
    expect(await extractBinary(bytes, "application/pdf", signal(), "file:///guide.pdf")).toEqual([
      { text: "First page", format: "text", source: { uri: "file:///guide.pdf", page: 1 } },
      { text: "Second page", format: "text", source: { uri: "file:///guide.pdf", page: 2 } },
    ]);
    // SDKs may transfer their input buffer; the reader must retain caller bytes.
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(pdfSdk.tasks[0]?.destroy).toHaveBeenCalledOnce();
  });

  it("rejects a real PDF with no text layer instead of claiming OCR", async () => {
    await expect(extractBinary(pdfFixture([""]), "application/pdf", signal())).rejects.toMatchObject({
      code: "ExtractionUnavailable",
    });
    expect(pdfSdk.tasks[0]?.destroy).toHaveBeenCalledOnce();
  });

  it("retains empty native PDF pages when other pages contain text", async () => {
    expect(await extractBinary(pdfFixture(["First", "", "Third"]), "application/pdf", signal())).toEqual([
      { text: "First", format: "text", source: { page: 1 } },
      { text: "", format: "text", source: { page: 2 } },
      { text: "Third", format: "text", source: { page: 3 } },
    ]);
  });

  it("preserves contiguous PDF word fragments across font changes", async () => {
    const bytes = pdfStreamsFixture(["BT /F1 12 Tf 72 720 Td (hel) Tj /F1 14 Tf (lo) Tj ET"]);
    expect(await extractBinary(bytes, "application/pdf", signal())).toEqual([
      { text: "hello", format: "text", source: { page: 1 } },
    ]);
  });

  it("preserves PDF.js separators for geometrically separated words", async () => {
    const bytes = pdfStreamsFixture(["BT /F1 12 Tf 72 720 Td (hello) Tj 35 0 Td (world) Tj ET"]);
    expect(await extractBinary(bytes, "application/pdf", signal())).toEqual([
      { text: "hello world", format: "text", source: { page: 1 } },
    ]);
  });

  it("extracts paragraphs and XML entities from a real DOCX archive", async () => {
    expect(await extractBinary(docxFixture(), docx, signal(), "file:///notes.docx")).toEqual([
      { text: "First paragraph\n\nSecond paragraph & text\n\n", format: "text", source: { uri: "file:///notes.docx" } },
    ]);
  });

  it("extracts every XLSX sheet including cached formula results", async () => {
    expect(await extractBinary(xlsxFixture(), xlsx, signal(), "file:///report.xlsx")).toEqual([
      { text: "Sheet: People\nName\tCount\nAlice\t3", format: "text", source: { uri: "file:///report.xlsx" } },
      { text: "Sheet: Totals\nTotal\t3", format: "text", source: { uri: "file:///report.xlsx" } },
    ]);
  });

  it.each(["application/pdf", docx, xlsx])("preserves %s parser errors", async (mimeType) => {
    const error = await extractBinary(new Uint8Array([1, 2, 3]), mimeType, signal()).then(
      () => undefined, (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty("code", "ExtractionUnavailable");
    expect(error).not.toHaveProperty("name", "TessarError");
    if (mimeType === "application/pdf") expect(pdfSdk.tasks[0]?.destroy).toHaveBeenCalledOnce();
  });

  it("preserves an already-aborted signal's reason", async () => {
    const controller = new AbortController();
    const reason = new Error("reader cancelled");
    controller.abort(reason);
    await expect(extractBinary(pdfFixture(), "application/pdf", controller.signal)).rejects.toBe(reason);
  });

  it("cancels a PDF during asynchronous SDK loading", async () => {
    const controller = new AbortController();
    const reason = new Error("stop PDF loading");
    pdfSdk.onLoad = () => queueMicrotask(() => controller.abort(reason));
    const result = extractBinary(pdfFixture(), "application/pdf", controller.signal);
    await expect(result).rejects.toBe(reason);
    expect(pdfSdk.tasks[0]?.destroy).toHaveBeenCalledOnce();
    await expect(vi.mocked(pdfSdk.tasks[0]!.destroy).mock.results[0]?.value).resolves.toBeUndefined();
    pdfSdk.onLoad = undefined;
    // A subsequent real extraction still works after the cancelled SDK task.
    expect(await extractBinary(pdfFixture(["After cancellation"]), "application/pdf", signal())).toMatchObject([
      { text: "After cancellation", source: { page: 1 } },
    ]);
  });
});
