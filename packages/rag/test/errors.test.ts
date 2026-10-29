import { afterEach, expect, it, vi } from "vitest";
import { TessarError } from "@tessar/core";
import { DocumentReader, TessarRagError } from "../src/index.js";
import { pdfFixture } from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

it("inherits the shared instance guard, native cause, source and details", () => {
  const cause = new Error("underlying");
  const failure: unknown = new TessarRagError("SourceReadFailed", "Failed", {
    source: "provider", details: { status: 503 }, cause,
  });
  expect(TessarRagError.isInstance(failure)).toBe(true);
  expect(TessarError.isInstance(failure)).toBe(true);
  if (!TessarRagError.isInstance(failure)) throw Error("Missing narrowing");
  expect(failure.name).toBe("TessarRagError");
  expect(failure.code).toBe("SourceReadFailed");
  expect(failure.source).toBe("provider");
  expect(failure.details).toEqual({ status: 503 });
  expect(failure.cause).toBe(cause);
  expect(failure.stack).toContain("Failed");
  expect(TessarRagError.isInstance(new TessarError("Other", "Base"))).toBe(false);
  expect(TessarRagError.isInstance({ name: "TessarRagError" })).toBe(false);
});

it("uses the RAG subclass for validation including shared core validators", () => {
  const reader = new DocumentReader();
  for (const operation of [
    () => reader.load({ source: {} } as never),
    () => reader.load({ id: " ", source: { text: "x" } }),
    () => reader.load({ source: { text: "x" } }, { metadata: { x: Infinity } }),
    () => reader.load({ source: { url: "not a URL" } }),
  ]) expect(operation).toThrow(TessarRagError);
});

it("uses the RAG subclass for duplicate IDs and cancellation", async () => {
  const reader = new DocumentReader();
  const reading = reader.load({ id: "active", source: { text: "hello" } });
  expect(() => reader.load({ id: "active", source: { text: "other" } })).toThrow(TessarRagError);
  expect(() => reading.cancel(1 as never)).toThrow(TessarRagError);
  reading.cancel("Cancel reading");
  const error: unknown = await reading.result().catch(error => error);
  expect(TessarRagError.isInstance(error)).toBe(true);
  expect(error).toMatchObject({ code: "Cancelled", message: "Cancel reading" });
});

it("uses the RAG subclass for unsupported content and unavailable extraction", async () => {
  const reader = new DocumentReader();
  await expect(reader.load({ source: { data: new Uint8Array(), mimeType: "image/png" } }).result())
    .rejects.toBeInstanceOf(TessarRagError);
  await expect(reader.load({ source: { data: pdfFixture([""]), mimeType: "application/pdf" } }).result())
    .rejects.toBeInstanceOf(TessarRagError);
});

it("preserves native filesystem, decoding and parser exceptions", async () => {
  const reader = new DocumentReader();
  for (const reading of [
    reader.load({ source: { path: "missing-rag-error-fixture.txt" } }),
    reader.load({ source: { text: "{", mimeType: "application/json" } }),
    reader.load({ source: { data: new Uint8Array([0xff]), mimeType: "text/plain" } }),
    reader.load({ source: { data: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" } }),
  ]) {
    const error: unknown = await reading.result().catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(TessarError.isInstance(error)).toBe(false);
  }
});

it("preserves an external exception even when it extends the shared base", async () => {
  const failure = new TessarError("UpstreamFailed", "External service", { source: "provider" });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
  await expect(new DocumentReader().load({ source: { url: "https://example.com/notes.txt" } }).result())
    .rejects.toBe(failure);
  expect(TessarRagError.isInstance(failure)).toBe(false);
});

it("does not replace a sibling error class that uses the default core source", async () => {
  class OtherTessarError extends TessarError {}
  const failure = new OtherTessarError("OtherFailure", "Sibling error");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
  await expect(new DocumentReader().load({ source: { url: "https://example.com/notes.txt" } }).result())
    .rejects.toBe(failure);
});
