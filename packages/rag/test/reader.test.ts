import { expect, it, onTestFinished } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, type RequestListener } from "node:http";
import { DocumentReader, TessarRagError } from "../src/index.js";
import { docxFixture, pdfFixture, xlsxFixture } from "./fixtures.js";

async function server(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

it("starts one task with bare generated UUID, repeated result and snapshotted metadata", async () => {
  const metadata = { project: "cube", nested: { revision: 1 } };
  const reading = new DocumentReader().load({ source: { text: "# Guide", mimeType: "TEXT/MARKDOWN; charset=utf-8" } }, { metadata });
  metadata.nested.revision = 2;
  expect(reading.id).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  expect(reading.result()).toBe(reading.result());
  const result = await reading.result();
  expect(result).toEqual([{ text: "# Guide", format: "markdown", metadata: { project: "cube", nested: { revision: 1 } } }]);
  expect(result[0]).not.toHaveProperty("source");
  reading.cancel();
  expect(await reading.result()).toBe(result);
});

it("accepts empty text and copies byte input before asynchronous extraction", async () => {
  const reader = new DocumentReader();
  expect(await reader.load({ source: { text: "" } }).result()).toEqual([{ text: "", format: "text", metadata: {} }]);
  const bytes = Buffer.from("hello");
  const task = reader.load({ source: { data: bytes, mimeType: "text/plain" } });
  bytes.fill(0);
  expect((await task.result())[0]?.text).toBe("hello");
});

it("guards active IDs per Reader and releases them after success and failure", async () => {
  const reader = new DocumentReader();
  const input = { id: "read-one", source: { text: "first" } };
  const first = reader.load(input);
  expect(() => reader.load(input)).toThrow(expect.objectContaining({ code: "RegistrationConflict" }));
  const other = new DocumentReader().load(input);
  expect((await other.result())[0]?.text).toBe("first");
  await first.result();
  await reader.load(input).result();
  await expect(reader.load({ id: input.id, source: { text: "{", mimeType: "application/json" } }).result()).rejects.toBeInstanceOf(SyntaxError);
  await reader.load(input).result();
});

it.each([
  {}, { source: {} }, { id: " ", source: { text: "x" } }, { id: null, source: { text: "x" } },
  { source: { path: " " } }, { source: { url: "file:///etc/passwd" } },
  { source: { text: "x", url: "https://example.com" } },
  { source: { data: new Uint8Array() } },
  { source: { text: "x", unknown: true } },
  { source: { text: "x" }, signal: new AbortController().signal },
])("rejects invalid or mixed input at admission: %j", input => {
  expect(() => new DocumentReader().load(input as never)).toThrow();
});

it("rejects non-object metadata and non-JSON metadata synchronously", () => {
  const reader = new DocumentReader();
  for (const metadata of [[], null, new Date(), { value: Infinity }])
    expect(() => reader.load({ source: { text: "x" } }, { metadata } as never)).toThrow();
});

it("returns real file provenance and preserves native filesystem errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tessar-reader-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = join(directory, "guide.md");
  await writeFile(file, "# Local guide");
  const reader = new DocumentReader();
  expect(await reader.load({ source: { path: file } }).result()).toEqual([
    { text: "# Local guide", format: "markdown", source: { uri: pathToFileURL(file).href }, metadata: {} },
  ]);
  await expect(reader.load({ source: { path: join(directory, "missing.txt") } }).result()).rejects.toMatchObject({ code: "ENOENT" });
});

it("extracts HTML without scripts and preserves existing Markdown structures", async () => {
  const result = await new DocumentReader().load({ source: {
    text: "<html><head><style>bad-style</style></head><body><h1>Guide</h1><p>Hello <strong>world</strong></p><script>bad-script</script></body></html>",
    mimeType: "text/html",
  } }).result();
  expect(result[0]?.format).toBe("markdown");
  expect(result[0]?.text).toContain("# Guide");
  expect(result[0]?.text).toContain("**world**");
  expect(result[0]?.text).not.toMatch(/bad-script|bad-style/);
});

it("preserves JSON number spelling and parses quoted CSV fields into Markdown", async () => {
  const reader = new DocumentReader();
  const json = '{"big":12345678901234567890}';
  expect((await reader.load({ source: { text: json, mimeType: "application/json" } }).result())[0]?.text).toBe(json);
  const csv = 'name,note\r\n"Alice, B","line1\nline2 | safe"';
  const result = (await reader.load({ source: { text: csv, mimeType: "text/csv" } }).result())[0];
  expect(result?.format).toBe("markdown");
  expect(result?.text).toContain("Alice, B");
  expect(result?.text).toContain("line1<br>line2 \\| safe");
});

it("rejects unsupported MIME and invalid UTF-8 without disguising them as empty content", async () => {
  const reader = new DocumentReader();
  await expect(reader.load({ source: { data: new Uint8Array(), mimeType: "image/png" } }).result()).rejects.toMatchObject({ code: "UnsupportedFormat" });
  await expect(reader.load({ source: { data: new Uint8Array([0xff]), mimeType: "text/plain" } }).result()).rejects.toBeInstanceOf(TypeError);
});

it("uses HTTP MIME, final redirect URI and extension fallback", async () => {
  const url = await server((req, res) => {
    if (req.url === "/start") { res.writeHead(302, { location: "/guide.md" }).end(); return; }
    res.end("# Remote guide");
  });
  const result = await new DocumentReader().load({ source: { url: url + "/start" } }).result();
  expect(result).toEqual([{ text: "# Remote guide", format: "markdown", source: { uri: url + "/guide.md" }, metadata: {} }]);
});

it("rejects HTTP errors and explicit unsupported content types", async () => {
  const url = await server((req, res) => {
    if (req.url === "/missing") res.writeHead(404).end("missing");
    else res.writeHead(200, { "content-type": "image/png" }).end("not text");
  });
  const reader = new DocumentReader();
  const error: unknown = await reader.load({ source: { url: url + "/missing" } }).result().catch(error => error);
  expect(TessarRagError.isInstance(error)).toBe(true);
  expect(error).toMatchObject({ code: "SourceReadFailed", source: "provider", details: { status: 404 } });
  await expect(reader.load({ source: { url: url + "/image.txt" } }).result()).rejects.toMatchObject({ code: "UnsupportedFormat" });
});

it("cancels immediately without public signal and leaves another read unaffected", async () => {
  const reader = new DocumentReader();
  const reading = reader.load({ source: { text: "cancel me" } });
  const next = reader.load({ source: { text: "keep me" } });
  expect(Object.keys(reading).sort()).toEqual(["cancel", "id", "result"]);
  reading.cancel("User cancelled");
  reading.cancel();
  await expect(reading.result()).rejects.toMatchObject({ code: "Cancelled", message: "User cancelled" });
  expect((await next.result())[0]?.text).toBe("keep me");
});

it("cancels an HTTP body while extraction is waiting", async () => {
  const entered = Promise.withResolvers<void>();
  const url = await server((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("not finished");
    entered.resolve();
  });
  const reading = new DocumentReader().load({ source: { url } });
  await entered.promise;
  reading.cancel("Stop downloading");
  await expect(reading.result()).rejects.toMatchObject({ code: "Cancelled" });
});

it.each([
  ["application/pdf", pdfFixture, "First page"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", docxFixture, "First paragraph"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsxFixture, "Sheet: People"],
] as const)("reads real %s through the public task and keeps caller metadata separate", async (mimeType, fixture, text) => {
  const task = new DocumentReader().load({ source: { data: fixture(), mimeType } }, { metadata: { project: "cube" } });
  const contents = await task.result();
  expect(contents[0]?.text).toContain(text);
  expect(contents.every(content => JSON.stringify(content.metadata) === '{"project":"cube"}')).toBe(true);
});
