import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import * as events from "../packages/core/dist/events/type.js";

const source = await readFile("packages/core/dist/events/type.d.ts", "utf8");
const entries = new Map();
const pattern = /^        (?:(?:"([^"]+)")|(\w+)): (HookSpec|Transform|Decision)</gm;
function args(text) {
  let depth = 0, begin = 0;
  const result = [];
  for (let i = 0; i < text.length; i++) {
    if ("<{[(".includes(text[i])) depth++;
    else if (">}])".includes(text[i])) depth--;
    else if (text[i] === "," && depth === 0) { result.push(text.slice(begin, i).trim()); begin = i + 1; }
  }
  result.push(text.slice(begin).trim());
  return result;
}
for (const match of source.matchAll(pattern)) {
  const start = match.index + match[0].length;
  let depth = 1, end = start;
  while (depth && end < source.length) {
    if (source[end] === "<") depth++;
    if (source[end] === ">") depth--;
    end++;
  }
  const parameters = args(source.slice(start, end - 1));
  const form = match[3];
  entries.set(match[1] ?? match[2], {
    payload: parameters[0],
    result: form === "Transform" ? parameters[0] : form === "Decision" ? "ControlDecision" : parameters[1] ?? "void",
    context: form === "Transform" ? "E" : form === "Decision" ? "D" : ({ SessionHookContext: "S", ThreadHookContext: "T" })[parameters[2]] ?? "H",
  });
}
const aliases = new Map();
function visit(value, path) {
  if (typeof value === "string" && value in events.hookKinds) aliases.set(value, path);
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
}
for (const [key, value] of Object.entries(events)) if (key !== "hookKinds") visit(value, key);
const groups = [
  ["Framework và UI", ["ready", "shutdown", "diagnostic", "state_changed"]],
  ["Session", Object.keys(events.hookKinds).filter(name => name.startsWith("session."))],
  ["Thread", Object.keys(events.hookKinds).filter(name => name.startsWith("thread."))],
  ["Input và Stream", Object.keys(events.hookKinds).filter(name => name.startsWith("input.") || name.startsWith("stream."))],
  ["Turn, context và tool selection", Object.keys(events.hookKinds).filter(name => /^(turn|context|tools)\./.test(name))],
  ["Model", Object.keys(events.hookKinds).filter(name => name.startsWith("model."))],
  ["Message", Object.keys(events.hookKinds).filter(name => name.startsWith("message."))],
  ["Tool và checkpoint", Object.keys(events.hookKinds).filter(name => /^(tool|checkpoint)\./.test(name))],
];
const compact = text => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
const code = text => "`" + compact(text).replaceAll("|", "\\|") + "`";
const documented = new Set();
const catalog = groups.map(([title, names]) => {
  const rows = names.map(name => {
    const entry = entries.get(name), alias = aliases.get(name);
    assert.ok(entry && alias, "Missing public event " + name);
    assert.ok(!documented.has(name), "Duplicate event " + name);
    documented.add(name);
    const label = code(alias) + (alias !== name ? "<br>" + code(JSON.stringify(name)) : "");
    return `| ${label} | ${events.hookKinds[name]} | ${code(entry.payload)} | ${code(entry.result)} / ${entry.context} |`;
  });
  return `### ${title}\n\n| Map (string nếu khác) | Kind | event.payload | Return / context |\n| --- | --- | --- | --- |\n${rows.join("\n")}`;
}).join("\n\n");
assert.equal(documented.size, Object.keys(events.hookKinds).length);
assert.equal(documented.size, entries.size);
const path = "docs/plugin-api-and-events.md";
let doc = await readFile(path, "utf8");
assert.ok(doc.includes("<!-- EVENT_CATALOG -->"));
doc = doc.replace("<!-- EVENT_CATALOG -->", `${documented.size} event built-in hiện tại:\n\n${catalog}`);
doc = doc.split("\n").map(line => line.startsWith("|") ? line.replace(/`[^`]*`/g, block => block.replace(/(?<!\\)\|/g, "\\|")) : line).join("\n");
await writeFile(path, doc);
console.log(`Documented ${documented.size} events; aliases, kinds, payloads, return types and contexts match built declarations.`);
