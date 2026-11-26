import assert from "node:assert/strict";
import { mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTool } from "@tessar/core/tool";
import { createReadFile, TessarWorkspaceError } from "@tessar/workspace";
import { regularFileMode, resolveTarget } from "./results/fs-typescript/workspace.js";

const WARMUP = 15;
const SAMPLES = 120;
const READ_BUFFER_BYTES = 8 * 1024;
const MAX_PAGE_BYTES = 50 * 1024;
const FIRST_LINE = 1;
const MAX_PAGE_LINES = 2_000;
const LARGE_FILE_LINES = 65_536;
const INVALID_READ = "InvalidRead";
const LF = 0x0a;
const PDF_HEADER = Buffer.from("%PDF-");
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function invalidRead(message) {
  throw new TessarWorkspaceError(INVALID_READ, message, { source: "tool" });
}

async function referenceRead(root, { path, startLine = FIRST_LINE, limit = MAX_PAGE_LINES }, signal) {
  signal.throwIfAborted();
  if (startLine < FIRST_LINE || limit < 1) invalidRead("startLine and limit must be positive");
  const pageLines = Math.min(limit, MAX_PAGE_LINES);
  const workspace = await realpath(root);
  if (!(await stat(workspace)).isDirectory())
    throw new TessarWorkspaceError("InvalidPath", "The workspace root must be a directory", { source: "tool" });
  const target = await resolveTarget(workspace, path);
  regularFileMode(target.current, target.path);
  const file = await open(target.target, "r");
  try {
    const chunk = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    const page = Buffer.allocUnsafe(MAX_PAGE_BYTES);
    let line = 1;
    let length = 0;
    let completeBytes = 0;
    let nextLine = null;
    let first = true;

    readPage: for (; ;) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      const data = chunk.subarray(0, bytesRead);
      if (first && data.subarray(0, PDF_HEADER.length).equals(PDF_HEADER))
        invalidRead(`Expected a UTF-8 text file: ${target.path}`);
      first = false;
      let offset = 0;
      while (offset < bytesRead) {
        const newline = data.indexOf(LF, offset);
        const end = newline === -1 ? bytesRead : newline + 1;
        if (line >= startLine) {
          if (line - startLine >= pageLines) {
            nextLine = line;
            break readPage;
          }
          if (length + end - offset > MAX_PAGE_BYTES) {
            if (completeBytes === 0)
              invalidRead(`Line ${line} exceeds ${MAX_PAGE_BYTES} bytes: ${target.path}`);
            length = completeBytes;
            nextLine = line;
            break readPage;
          }
          data.copy(page, length, offset, end);
          length += end - offset;
        }
        if (newline !== -1) {
          line++;
          completeBytes = length;
        }
        offset = end;
      }
    }
    signal.throwIfAborted();
    let text;
    try {
      text = decoder.decode(page.subarray(0, length));
    } catch {
      invalidRead(`Expected a UTF-8 text file: ${target.path}`);
    }
    if (text.includes("\0")) invalidRead(`Expected a UTF-8 text file: ${target.path}`);
    return { text, nextLine };
  } finally {
    await file.close();
  }
}

function stats(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  return { medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

const temporaryRoot = resolve(tmpdir());
const root = await mkdtemp(join(temporaryRoot, "tessar-fs-read-bench-"));
const context = { signal: new AbortController().signal };
const line = "x".repeat(62) + "\r\n";
const shortLine = "x".repeat(22) + "\r\n";
const largeFileBytes = Buffer.byteLength(line) * LARGE_FILE_LINES;
const shortLineFileBytes = Buffer.byteLength(shortLine) * LARGE_FILE_LINES;
const cases = {
  wholeSmallFile: { input: { path: "small.txt" }, fileBytes: 4096, text: line.repeat(64), nextLine: null },
  lineCappedPage: { input: { path: "short-lines.txt" }, fileBytes: shortLineFileBytes, text: shortLine.repeat(2_000), nextLine: 2_001 },
  byteCappedPage: { input: { path: "large.txt" }, fileBytes: largeFileBytes, text: line.repeat(800), nextLine: 801 },
  pageNearEnd: { input: { path: "short-lines.txt", startLine: 63_001 }, fileBytes: shortLineFileBytes, text: shortLine.repeat(2_000), nextLine: 65_001 },
};

try {
  await writeFile(join(root, "small.txt"), cases.wholeSmallFile.text);
  await writeFile(join(root, "large.txt"), line.repeat(LARGE_FILE_LINES));
  await writeFile(join(root, "short-lines.txt"), shortLine.repeat(LARGE_FILE_LINES));
  const rust = createReadFile({ root });
  const typescript = createTool({
    name: rust.name,
    description: rust.description,
    schema: rust.schema,
    execute: (input, { signal }) => referenceRead(root, input, signal),
  });
  const variants = [["typescript", typescript], ["rust", rust]];
  const measurements = {};
  for (const [name, { input, fileBytes, text, nextLine }] of Object.entries(cases)) {
    const expected = [{ type: "data", data: { text, nextLine } }];
    const samples = { typescript: [], rust: [] };
    for (let index = 0; index < WARMUP + SAMPLES; index++) {
      for (const [variant, tool] of index % 2 ? variants.toReversed() : variants) {
        const start = performance.now();
        const result = await tool.execute(input, context);
        const elapsed = performance.now() - start;
        assert.deepEqual(result.content, expected, `${name} ${variant}`);
        if (index >= WARMUP) samples[variant].push(elapsed);
      }
    }
    measurements[name] = {
      fileBytes,
      returnedBytes: Buffer.byteLength(text),
      typescript: stats(samples.typescript),
      rust: stats(samples.rust),
    };
  }
  console.log(JSON.stringify({
    platform: `${process.platform}-${process.arch}`,
    cpu: cpus()[0]?.model,
    node: process.version,
    warmup: WARMUP,
    samples: SAMPLES,
    measurements,
  }, null, 2));
} finally {
  assert.equal(resolve(root, ".."), temporaryRoot);
  await rm(root, { recursive: true, force: true });
}
