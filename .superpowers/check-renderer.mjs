import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { stripVTControlCharacters } from "node:util";
import vm from "node:vm";

const path = process.argv[2] ?? new URL("./tessar-implement-main.ts", import.meta.url);
const source = (await readFile(path, "utf8"))
  .split("const openrouter =")[0]
  .replace(/^import [\s\S]*? from "[^"]+";\r?\n/gm, "");
const script = stripTypeScriptTypes(source);
const state = {
  status: "running", currentMessage: null, tools: [], interrupt: null,
  queuedInputs: 0, error: null,
  messages: [{ id: "user", role: "user", content: [{ type: "text", text: "Hello" }] }],
};
function renderer(isTTY) {
  let output = "";
  const context = vm.createContext({
    process: { stdout: { isTTY, write: chunk => { output += chunk; } } },
    cursorTo() {}, clearScreenDown() {}, stripVTControlCharacters,
  });
  vm.runInContext(script, context);
  return {
    render(value) { context.value = value; vm.runInContext("render(value)", context); },
    finish() { vm.runInContext("if (typeof finishRender === 'function') finishRender()", context); },
    output() { return output; },
  };
}
const plain = renderer(false);
plain.render(state);
assert.equal(plain.output(), "", "Piped output must not repeat intermediate snapshots");
const complete = {
  ...state, status: "completed", queuedInputs: 1,
  messages: [...state.messages, {
    id: "assistant", role: "assistant", content: [
      { type: "reasoning", text: "Thinking text" },
      { type: "tool-call", toolCallId: "call", name: "search", arguments: { query: "test" } },
      { type: "text", text: "Final answer" },
    ],
  }, { id: "result", role: "tool", toolCallId: "call", content: [{ type: "data", data: { found: true } }] }],
  tools: [{ id: "tool", toolCallId: "call", name: "search", status: "succeeded", progress: { percent: 100 }, error: null }],
};
plain.render(complete);
plain.finish();
const output = plain.output();
assert.equal((output.match(/\bUSER\b/g) ?? []).length, 1);
for (const text of ["Thinking text", "Final answer", "search", "query", "found", "percent", "Queued inputs: 1", "Status: completed"]) assert.ok(output.includes(text), text);
assert.ok(!output.includes("\x1b"), "Piped output must contain no terminal escape codes");
const tty = renderer(true);
tty.render(state);
const first = tty.output();
tty.render(state);
assert.equal(tty.output(), first, "Unchanged snapshots must not repaint");
tty.render(complete);
tty.finish();
assert.equal((tty.output().match(/\x1b\[\?1049h/g) ?? []).length, 1);
assert.ok(tty.output().includes("\x1b[?1049l"), "Restore main terminal screen");
assert.ok(tty.output().includes("\x1b[?25h"), "Restore cursor");
const waiting = renderer(false);
waiting.render({ ...state, interrupt: { payload: { question: "Approve?" } }, error: { message: "Something failed" } });
waiting.finish();
assert.ok(waiting.output().includes("Approve?"));
assert.ok(waiting.output().includes("Something failed"));
console.log("Renderer checks passed: plain output, TTY lifecycle, reasoning, tools, approval and errors.");
