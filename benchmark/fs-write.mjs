import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApplyPatch, createEditFile, TessarWorkspaceError } from "@tessar/workspace";
import { createApplyPatch as baselineApplyPatch } from "./results/fs-typescript/apply-patch.js";
import { createEditFile as baselineEditFile } from "./results/fs-typescript/edit-file.js";
import { TessarFsError } from "./results/fs-typescript/errors.js";

const WARMUP = 15;
const SAMPLES = 120;
const PARITY_ONLY = "--parity-only";

const patch = (...lines) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const add = (path, text) => [`*** Add File: ${path}`, `+${text}`];
const update = (path, before, after) => [`*** Update File: ${path}`, "@@", `-${before}`, `+${after}`];
const replace = (oldText, newText) => ({ oldText, newText });
const context = { signal: new AbortController().signal };
const temporaryRoot = resolve(tmpdir());
const directory = await mkdtemp(join(temporaryRoot, "tessar-fs-bench-"));

async function fileAt(root, path) {
  try {
    return await readFile(join(root, path));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function runCase(tool, root, { input, seed, files }) {
  for (const [path, text] of Object.entries(seed ?? {})) await writeFile(join(root, path), text);
  let outcome;
  try {
    const message = await tool.execute(input, context);
    outcome = message.content;
  } catch (error) {
    const name = error instanceof TessarWorkspaceError ? TessarFsError.name : error.constructor.name;
    outcome = { name, code: error.code, message: error.message };
  }
  return { outcome, files: await Promise.all(files.map((path) => fileAt(root, path))) };
}

const patchCases = [
  { input: patch(...update("order.ts", "mới", "đã trả"), ...add("test/order.ts", "// test")),
    seed: { "order.ts": "mới\n" }, files: ["order.ts", "test/order.ts"] },
  { input: patch("*** Update File: order.ts", "@@", " first", "-status", "+paid", "@@", " second", "-status", "+shipped"),
    seed: { "order.ts": "\uFEFFfirst\r\nstatus\r\nsecond\nstatus" }, files: ["order.ts"] },
  { input: patch("*** Update File: order.ts", "@@", "-remove"),
    seed: { "order.ts": "keep\r\nremove\n" }, files: ["order.ts"] },
  { input: patch(...add("before.ts", "new"), ...update("order.ts", "missing", "paid")),
    seed: { "order.ts": "original" }, files: ["before.ts", "order.ts"] },
  { input: patch(...update("order.ts", "duplicate", "paid")), seed: { "order.ts": "duplicate\nduplicate\n" }, files: ["order.ts"] },
  { input: patch(...add("order.ts", "new")), seed: { "order.ts": "original" }, files: ["order.ts"] },
  { input: patch(...add("../outside.ts", "bad")), files: ["../outside.ts"] },
  { input: patch(...add("link/outside.ts", "bad")), files: ["link/outside.ts"] },
  { input: patch(...add("same", "file"), ...add("same/other.ts", "bad")), files: ["same"] },
  { input: patch("*** Update File: order.ts", "@@", "+new"), seed: { "order.ts": "" }, files: ["order.ts"] },
  { input: patch("*** Delete File: order.ts"), seed: { "order.ts": "original" }, files: ["order.ts"] },
];
if (process.platform === "win32") patchCases.push({
  input: patch(...update("order.ts", "before", "after"), ...add("bad*file.ts", "bad")),
  seed: { "order.ts": "before\n" }, files: ["order.ts"],
});

const orderPath = "order.ts";
const editCase = (original, edits, path = orderPath) => ({
  input: { path, edits },
  seed: original === undefined ? {} : { [orderPath]: original },
  files: [orderPath],
});
const editCases = [
  editCase("\uFEFFfirst \u{1f642}\r\nsecond\r\nkeep\nlast", [replace("first \u{1f642}\nsecond", "mới\nsecond"), replace("last", "cuối")]),
  editCase("first\rlast\r", [replace("first", "one\ntwo")]),
  editCase("original\nother\nlast", [replace("last", "tail"), replace("original", "new"), replace("other\n", "")]),
  editCase("first\r\nsecond\nlast", [replace("first\nsecond", "first\nsecond"), replace("last", "tail")]),
  editCase("first\r\nsecond", [replace("first\nsecond", "first\nsecond")]),
  editCase("status\nstatus\n", [replace("status", "paid")]),
  editCase("aaa", [replace("aa", "b")]),
  editCase("abcdefgh", [replace("abcd", "first"), replace("cdef", "second")]),
  editCase("first\nsecond\n", [replace("first", "would change"), replace("missing", "x")]),
  editCase("original", [replace("\uD800", "invalid")]),
  editCase("original", [replace("original", "\0")]),
  editCase(Buffer.from([0xff, 0xfe]), [replace("original", "new")]),
  editCase("original\0", [replace("original", "new")]),
  editCase(undefined, [replace("original", "new")]),
  editCase(undefined, [replace("original", "new")], "../outside.ts"),
  editCase(undefined, [replace("original", "new")], "link/order.ts"),
  editCase(undefined, [replace("original", "new")], "link"),
];
if (process.platform === "win32")
  editCases.push(editCase(undefined, [replace("original", "new")], "CON.ts"));

const source = Array.from({ length: 1024 }, (_, index) => `export const value${index} = ${index};\n`).join("") + "export const status = 'pending';\n";
const small = "export const nextValue = 1;\n".repeat(150) + "export const status = 'pending';\n";
const mixed = Array.from({ length: 24_000 }, (_, index) => `const value${index} = ${index};${index % 2 ? "\r\n" : "\n"}`).join("")
  + "export const status = 'pending';\r\nconst count = 1;\nconst label = 'before';\r\n";
const before = "export const status = 'pending';";
const after = "export const status = 'paid';";
const workloads = {
  patchCreate: { input: { patch: patch(...add(orderPath, "x".repeat(4096))) }, paths: [orderPath] },
  patchEdit: { input: { patch: patch(...update(orderPath, before, after)) }, paths: [orderPath], source },
  patchMultiFile: {
    input: { patch: patch(...[1, 2, 3].flatMap((index) => update(`order-${index}.ts`, before, after))) },
    paths: ["order-1.ts", "order-2.ts", "order-3.ts"],
    source,
  },
  editFileSmall: { input: { path: orderPath, edits: [replace(before, after)] }, paths: [orderPath], source: small },
  editFileSameSource: { input: { path: orderPath, edits: [replace(before, after)] }, paths: [orderPath], source },
  editFileMixedEndings: {
    input: { path: orderPath, edits: [replace(before, after), replace("const count = 1;", "const count = 2;"), replace("const label = 'before';", "const label = 'after';")] },
    paths: [orderPath],
    source: mixed,
  },
};

function stats(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  return { medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

try {
  const outside = join(directory, "outside");
  await mkdir(outside);
  const parity = [
    [baselineApplyPatch, createApplyPatch, patchCases.map((example) => ({ ...example, input: { patch: example.input } }))],
    [baselineEditFile, createEditFile, editCases],
  ];
  for (const [baseline, native, cases] of parity) {
    for (const [index, example] of cases.entries()) {
      const tsRoot = join(directory, `${baseline.name}-${index}-ts`);
      const rsRoot = join(directory, `${native.name}-${index}-rs`);
      for (const root of [tsRoot, rsRoot]) {
        await mkdir(root);
        await symlink(outside, join(root, "link"), "junction");
      }
      const ts = baseline({ root: tsRoot });
      const actual = await runCase(native({ root: rsRoot }), rsRoot, example);
      assert.deepEqual(actual, await runCase(ts, tsRoot, example), `${ts.name} case ${index + 1}`);
    }
  }
  const parityCases = patchCases.length + editCases.length;
  if (process.argv.includes(PARITY_ONLY))
    console.log(`Passed ${parityCases} TypeScript/Rust parity cases (${patchCases.length} apply_patch, ${editCases.length} edit_file)`);
  else {
    const measurements = {};
    for (const [name, workload] of Object.entries(workloads)) {
      const tsRoot = join(directory, `${name}-ts`);
      const rsRoot = join(directory, `${name}-rs`);
      await mkdir(tsRoot);
      await mkdir(rsRoot);
      const isPatch = "patch" in workload.input;
      const ts = (isPatch ? baselineApplyPatch : baselineEditFile)({ root: tsRoot });
      const rs = (isPatch ? createApplyPatch : createEditFile)({ root: rsRoot });
      const samples = { typescript: [], rust: [] };
      const variants = [["typescript", tsRoot, ts], ["rust", rsRoot, rs]];
      for (let index = 0; index < WARMUP + SAMPLES; index++) {
        for (const [, root] of variants) {
          for (const path of workload.paths) {
            const target = join(root, path);
            if (workload.source !== undefined) await writeFile(target, workload.source);
            else await rm(target, { force: true });
          }
        }
        for (const [variant, , tool] of index % 2 ? variants.toReversed() : variants) {
          const start = performance.now();
          const result = await tool.execute(workload.input, context);
          const elapsed = performance.now() - start;
          if (index >= WARMUP) samples[variant].push(elapsed);
          if (isPatch) assert.deepEqual(result.content[0].data.paths, workload.paths);
          else assert.deepEqual(result.content, [{ type: "text", text: `Edited ${workload.input.path}` }]);
        }
      }
      for (const path of workload.paths)
        assert.deepEqual(await fileAt(tsRoot, path), await fileAt(rsRoot, path), `${name} file ${path}`);
      measurements[name] = {
        sourceBytes: workload.source === undefined ? 0 : Buffer.byteLength(workload.source),
        typescript: stats(samples.typescript),
        rust: stats(samples.rust),
      };
    }
    console.log(JSON.stringify({
      platform: `${process.platform}-${process.arch}`,
      cpu: cpus()[0]?.model,
      node: process.version,
      parityCases,
      parityByTool: { apply_patch: patchCases.length, edit_file: editCases.length },
      warmup: WARMUP,
      samples: SAMPLES,
      measurements,
    }, null, 2));
  }
} finally {
  assert.equal(resolve(directory, ".."), temporaryRoot);
  await rm(directory, { recursive: true, force: true });
}
