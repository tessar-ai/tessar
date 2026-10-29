import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { TessarError } from "@tessar/core";
import * as rag from "@tessar/rag";
import type { EmbeddingModel } from "@tessar/rag";
import { OpenAIEmbedding } from "@tessar/openai";

assert.deepEqual(Object.keys(rag).sort(), ["DocumentReader", "DocumentSplitter", "TessarRagError"]);
const reader = new rag.DocumentReader();
const metadata = { project: "handbook", nested: { revision: 1 } };
const source = { text: "# Setup\n\nRun locally.", mimeType: "text/markdown" };
const reading = reader.load({ id: "inline", source }, { metadata });
const result = reading.result();
assert.equal(reading.id, "inline");
assert.equal(reading.result(), result);
source.text = "changed after admission";
metadata.nested.revision = 2;
assert.deepEqual(await result, [{
  text: "# Setup\n\nRun locally.",
  format: "markdown",
  metadata: { project: "handbook", nested: { revision: 1 } },
}]);
reading.cancel("already completed");
assert.equal(reading.result(), result);
assert.equal((await result)[0]!.text, "# Setup\n\nRun locally.");

const splitter = new rag.DocumentSplitter({ strategy: "markdown", maxSize: 12 });
const contents = await result;
const chunks = splitter.chunk(contents);
assert.ok(Array.isArray(chunks));
assert.equal(chunks.map(chunk => chunk.text).join(""), contents[0]!.text);
for (const chunk of chunks) {
  assert.equal(chunk.text, contents[chunk.position.contentIndex]!.text.slice(chunk.position.start, chunk.position.end));
  assert.deepEqual(chunk.metadata, { project: "handbook", nested: { revision: 1 } });
  assert.ok(Array.from(chunk.text).length <= 12);
}
const tokenChunks = new rag.DocumentSplitter({
  strategy: "sentence", maxSize: 8, unit: "tokens", tokenizer: { count: text => text.length },
}).chunk(contents);
assert.ok(tokenChunks.every(chunk => chunk.text.length <= 8));
const embeddingRequests: Record<string, unknown>[] = [];
const embedding: EmbeddingModel = new OpenAIEmbedding({
  apiKey: "fixture", model: "fixture", dimensions: 2, maxRetries: 0,
  fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    embeddingRequests.push(body);
    const texts: string[] = typeof body.input === "string" ? [body.input] : body.input;
    return Response.json({
      object: "list", model: "fixture", usage: { prompt_tokens: 1, total_tokens: 1 },
      data: texts.map((text, index) => ({ index, object: "embedding", embedding: [text.length, 1] })).reverse(),
    });
  },
});
const pageVectors = await embedding.embedDocuments(contents);
assert.deepEqual(pageVectors, contents.map(content => [content.text.length, 1]));
const documentVectors = await embedding.embedDocuments(chunks);
assert.deepEqual(documentVectors, chunks.map(chunk => [chunk.text.length, 1]));
assert.deepEqual(await embedding.embedQuery("search"), [6, 1]);
assert.equal(embeddingRequests.length, 3);
assert.ok(embeddingRequests.every(body => body.dimensions === 2 && !("input_type" in body)));
assert.throws(
  () => new rag.DocumentSplitter({ strategy: "recursive", maxSize: 0 }),
  error => rag.TessarRagError.isInstance(error) && error.code === "InvalidConfiguration",
);
assert.equal(new rag.DocumentSplitter({ strategy: "recursive", maxSize: 1 })
  .chunk({ text: "x".repeat(350000), format: "text", metadata: {} }).length, 350000);

const bytes = new TextEncoder().encode("original");
const byteRead = reader.load({ source: { data: bytes, mimeType: "text/plain" } });
bytes.fill(0);
assert.equal((await byteRead.result())[0]!.text, "original");
assert.match(byteRead.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

const directory = await mkdtemp(join(tmpdir(), "tessar-rag-"));
const received = Promise.withResolvers<void>();
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.write("unfinished body");
  received.resolve();
});
try {
  const filename = join(directory, "notes.txt");
  await writeFile(filename, "Local file content.", "utf8");
  const file = await reader.load({ source: { path: filename } }).result();
  assert.deepEqual(file, [{
    text: "Local file content.",
    format: "text",
    source: { uri: pathToFileURL(filename).href },
    metadata: {},
  }]);
  await assert.rejects(
    reader.load({ source: { path: join(directory, "missing.txt") } }).result(),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
  await assert.rejects(reader.load({
    source: { data: new Uint8Array([0]), mimeType: "application/x-unsupported" },
  }).result());

  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const slow = reader.load({
    id: "slow-http",
    source: { url: `http://127.0.0.1:${address.port}/slow.txt` },
  });
  const slowResult = slow.result();
  assert.throws(
    () => reader.load({ id: "slow-http", source: { text: "duplicate" } }),
    (error: unknown) => rag.TessarRagError.isInstance(error) && TessarError.isInstance(error) && error.code === "RegistrationConflict",
  );
  const independent = reader.load({ source: { text: "independent read" } });
  await received.promise;
  slow.cancel("User cancelled");
  await assert.rejects(
    slowResult,
    (error: unknown) => rag.TessarRagError.isInstance(error) && TessarError.isInstance(error) && error.code === "Cancelled",
  );
  assert.equal(slow.result(), slowResult);
  assert.equal((await independent.result())[0]!.text, "independent read");
} finally {
  server.closeAllConnections();
  if (server.listening) {
    await new Promise<void>((done, reject) =>
      server.close((error) => error ? reject(error) : done()),
    );
  }
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
