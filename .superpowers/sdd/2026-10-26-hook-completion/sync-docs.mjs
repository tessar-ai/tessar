import { readFileSync as read, writeFileSync as write } from "node:fs";
import assert from "node:assert/strict";
import * as events from "../../../packages/core/dist/events/type.js";
const load = path => read(path, "utf8").replaceAll("\r\n", "\n");
const root = "packages/core/dist/";
function declarations(path) {
  return load(path).replace(/^import[\s\S]*?;\n/gm, "").replace(/^export \{\};?\n?/gm, "").replace(/^\/\/# sourceMappingURL=.*$/gm, "").replace(/^    (?:private |protected |#private;).*\n/gm, "").trim();
}
let api = load("docs/api-review.md");
function section(title, body) {
  const start = api.indexOf("### " + title + "\n");
  assert.ok(start >= 0, title);
  const end = api.indexOf("\n### ", start + 4);
  const block = api.slice(start, end < 0 ? api.length : end);
  assert.ok(block.includes("```ts\n"), title);
  api = api.slice(0, start) + block.replace(/```ts\n[\s\S]*?\n```/, () => "```ts\n" + body + "\n```") + api.slice(end < 0 ? api.length : end);
}
function declaration(path, name) {
  const source = declarations(path);
  const pattern = new RegExp("(?:^|\\n)(export (?:declare )?(?:class|interface|type|const) " + name + "\\b[\\s\\S]*?)(?=\\n(?:export |declare |interface |type |/\\*\\*)|$)");
  const value = source.match(pattern)?.[1];
  assert.ok(value, name);
  return value.trimEnd();
}
const session = declaration(root + "session.d.ts", "Session");
section("Session", session);
section("Session và paging", ["SessionOptions", "SessionThreadOptions", "SessionModelInfo", "ThreadTarget"].map(name => declaration(root + "session.d.ts", name)).join("\n\n"));
section("PluginContext và hook context", declarations(root + "plugins/context.d.ts"));
section("Effects và tracked services", ["EffectContext", "EffectDefinition", "defineEffect", "TrackedServices", "ExecutionHookContext"].map(name => {
  if (name === "defineEffect") return "export declare function defineEffect<I, O>(definition: EffectDefinition<I, O>): EffectDefinition<I, O>;";
  return declaration(root + "engine/tracked-effects.d.ts", name);
}).join("\n\n"));
section("Interruption definition và decision context", ["InterruptionDefinition", "DecisionHookContext"].map(name => declaration(root + "engine/interrupt.d.ts", name)).join("\n\n") + "\n\nexport declare function defineInterruption<R, D extends ResolvedDecision, P extends JsonValue = JsonValue>(definition: InterruptionDefinition<R, D, P>): InterruptionDefinition<R, D, P>;");
section("Model adapter/request/response contract", declarations(root + "models/contract.d.ts"));
section("Rendering snapshot types", ["RuntimePart", "RuntimeDraft", "RuntimeMessage", "StateTool", "RuntimeState"].map(name => declaration(root + "runtime-state.d.ts", name)).join("\n\n"));
section("OpenAIProvider", declaration("packages/openai/dist/provider.d.ts", "OpenAIProvider"));
const eventSource = declarations(root + "events/type.d.ts");
const eventStart = api.indexOf("### Payload dùng chung và helper quyết định\n");
const eventEnd = api.indexOf("### Plugin state definition\n", eventStart);
assert.ok(eventStart > 0 && eventEnd > eventStart);
api = api.slice(0, eventStart) + "### Event maps, payloads và quyết định theo boundary\n\nNguồn: `packages/core/dist/events/type.d.ts`. `PartEvent<N>` nằm trong model contract bên dưới. Các alias `Transform`, `Decision`, `PartHooks` chỉ giúp đọc hình dạng EventMap, không phải root exports.\n\n```ts\n" + eventSource + "\n```\n\n" + api.slice(eventEnd);
api = api.replace(/\| `\.snapshots\(\)`[^\n]*\n/g, "");
api = api.replace('models.stream(options)` | `{ model: ModelRef; request: ModelRequest; purpose: "auxiliary" }`', 'models.stream(request)` | `ModelRequest`');
api = api.replace('`DecisionHookContext.suspend(definition, payload): ControlDecision`', '`DecisionHookContext<D>.suspend(definition, payload): SuspendDecision`');
api = api.replace('`event.type === message.delta`', '`event.type === text.delta`');
api = api.replace('if (event.type === message.delta)', 'if (event.type === text.delta)');
api = api.replace('| `.list()` | Không có | `readonly SessionModelInfo[]`', '| `.info()` | Không có | Snapshot immutable `{ id, name, profile, options? }` của model đang chọn |\n| `.setEffort(level)` | `level: string` | `Promise<void>`; adapter ánh xạ sang native options và giữ các options khác |\n| `.list()` | Không có | `readonly SessionModelInfo[]`');
api = api.replace('sau khi lưu thành công có `session.modelChanged`; payload gồm `previous`, `model`, `previousOptions?`, `options?`.', 'sau khi lưu thành công có `session.modelChanged` khi đổi model/connection và `session.model.optionsChanged` khi options thay đổi. Options event chứa `model`, `previousOptions?`, `options?`; no-op không phát event. `setEffort(level)` giữ các options hiện tại; provider không hỗ trợ sẽ báo `UnsupportedOption`.');
api = api.replace('không có execution đang chạy, suspended cũng idle', 'không có execution đang chạy hoặc input đang xếp hàng; suspended không có queue cũng idle');
api = api.replace('2026-10-21', '2026-10-27').replace('2026-10-26', '2026-10-27');
write("docs/api-review.md", api);

// Preserve the hand-written use cases, regenerate only the event inventory.
let doc = load("docs/plugin-api-and-events.md");
const purpose = new Map();
for (const row of doc.split("\n")) {
  if (!row.startsWith("| `")) continue;
  const alias = row.match(/^\| `([^`]+)`/)?.[1];
  const cells = row.split(/(?<!\\)\|/);
  if (alias && cells.length >= 7) purpose.set(alias, cells.at(-2).trim());
}
const entries = new Map();
const pattern = /^        (?:(?:"([^"]+)")|(\w+)): (HookSpec|Transform|Decision)</gm;
function args(text) {
  let depth = 0, begin = 0; const result = [];
  for (let i = 0; i < text.length; i++) {
    if ("<{[(".includes(text[i])) depth++;
    else if (">}])".includes(text[i])) depth--;
    else if (text[i] === "," && depth === 0) { result.push(text.slice(begin, i).trim()); begin = i + 1; }
  }
  result.push(text.slice(begin).trim()); return result;
}
for (const match of eventSource.matchAll(pattern)) {
  const start = match.index + match[0].length; let depth = 1, end = start;
  while (depth && end < eventSource.length) { if (eventSource[end] === "<") depth++; if (eventSource[end] === ">") depth--; end++; }
  const parameters = args(eventSource.slice(start, end - 1)), form = match[3];
  entries.set(match[1] ?? match[2], { payload: parameters[0], result: form === "Transform" ? parameters[0] : parameters[1] ?? "void", context: form === "Transform" ? "E" : form === "Decision" ? "D" : ({ SessionHookContext: "S", ThreadHookContext: "T", 'import("../plugins/context.js").StateHookContext': "L" })[parameters[2]] ?? "H" });
}
const aliases = new Map();
function visit(value, path) { if (typeof value === "string" && value in events.hookKinds) aliases.set(value, path); else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key); }
for (const [key, value] of Object.entries(events)) if (key !== "hookKinds") visit(value, key);
for (const name of Object.keys(events.hookKinds)) if (/^(text|reasoning|tool.call)\./.test(name)) {
  entries.set(name, { payload: `PartEvent<"${name}">`, result: "void", context: "H" });
  purpose.set(name, name.endsWith(".start") ? "Quan sát bắt đầu sinh part; chưa phải thực thi tool." : name.endsWith(".delta") ? "Đọc text/thinking tăng dần; UI có thể dùng state_changed thay việc tự ghép." : "Quan sát part hoàn tất hoặc bị ngắt; tool arguments chỉ có khi completed.");
}
purpose.set("session.model.optionsChanged", "Cập nhật UI/audit sau khi options được lưu; đọc previousOptions/options hoặc model.info().");
const groups = [
  ["Framework và UI", ["ready", "shutdown", "diagnostic", "state_changed"]],
  ["Session", /^session\./], ["Thread", /^thread\./], ["Input và Stream", /^(input|stream)\./],
  ["Turn và context", /^(turn|context)\./], ["Model và provider", /^(model|provider)\./],
  ["Message và streaming part", /^(message|text|reasoning|tool.call)\./],
  ["Tool execution và checkpoint", /^(tool\.(?!call\.)|checkpoint\.)/],
];
const compact = value => value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
const code = value => "`" + compact(value).replaceAll("|", "\\|") + "`";
let count = 0;
const catalog = groups.map(([title, selection]) => {
  const names = Array.isArray(selection) ? selection : Object.keys(events.hookKinds).filter(name => selection.test(name));
  const rows = names.map(name => {
    const entry = entries.get(name), alias = aliases.get(name); assert.ok(entry && alias, name); count++;
    const label = code(alias) + (alias !== name ? "<br>" + code(JSON.stringify(name)) : "");
    let why = purpose.get(alias); assert.ok(why, "Missing use case for " + alias);
    if (name === "session.model-changed") why = "Cập nhật UI/audit khi model hoặc connection được chọn đã đổi; options có event riêng.";
    if (name === "turn.start") why = "Quan sát Turn mới và cập nhật plugin state tại lifecycle boundary; không chọn model.";
    return `| ${label} | ${events.hookKinds[name]} | ${code(entry.payload)} | ${code(entry.result)} / ${entry.context} | ${why} |`;
  });
  return `### ${title}\n\n| Map (string nếu khác) | Kind | event.payload | Return / context | Dùng khi nào |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}`;
}).join("\n\n");
assert.equal(count, Object.keys(events.hookKinds).length);
doc = doc.replace(/\d+ event built-in hiện tại:[\s\S]*?(?=## 6\.)/, `${count} event built-in hiện tại:\n\n${catalog}\n\nStreaming payload dùng chung messageId/partId/partIndex, attemptId/purpose/parentToolExecutionId. Start có startedAt và boundary; delta có delta; end có startedAt/endedAt, status completed/interrupted, boundary và text hoặc tool identity/arguments hoàn chỉnh. Interrupted tool-call không có arguments. Không có tool.call.delta.\n\n`);
doc = doc.replace('- **T**: `ThreadHookContext`', '- **L**: `StateHookContext`: H + plugin state, chỉ tại turn.start; không có execution control services.\n- **T**: `ThreadHookContext`');
doc = doc.replace(/\| `context.state.snapshots\(\)`[^\n]*\n/g, "");
doc = doc.replace('### State của plugin — chỉ E/D', '### State của plugin — E/D và lifecycle L');
doc = doc.replace('`context.models.stream(options)` | `{ model: ModelRef; request: ModelRequest; purpose: "auxiliary" }`', '`context.models.stream(request)` | `ModelRequest`');
doc = doc.replace('`tools.select` để lọc danh sách;', '`context.prepare` để lọc danh sách;');
doc = doc.replace('→ model.select → tools.select → context.prepare', '→ model.select → context.prepare');
doc = doc.replace('→ message.delta / model.usage', '→ text/reasoning/tool.call lifecycle / model.usage');
doc = doc.replace('`message.delta`', '`text.delta` / `reasoning.delta`');
doc = doc.replace('| `model.list()`', '| `model.info()` | Snapshot `{ id, name, profile, options? }` hiện tại |\n| `model.setEffort(level)` | `string` → `Promise<void>`; mapping thuộc provider |\n| `model.list()`');
doc = doc.slice(0, doc.indexOf('## 11.')) + `## 11. Ranh giới cần phân biệt\n\n- context.prepare sửa context và tập tool được quảng bá; tool.before vẫn kiểm tra quyền thực thi.\n- provider.request sửa body đã encode, không đổi credentials/model/streaming. Model phụ dùng cùng provider boundary nhưng không tự chạy context.prepare của loop cha.\n- tool.call là sinh lời gọi; tool.start/update/end/error là thực thi. Không có argument delta công khai.\n- text/reasoning/tool.call là quan sát; state_changed là snapshot UI đã tổng hợp. Part status chỉ ở RAM, không gửi model hoặc lưu DB.\n- Thread mutation phát một notification sau cập nhật Session. checkpoint.committed là mốc durable commit.\n- Decision theo boundary; không trả một ControlDecision bất kỳ. Giá trị không hợp lệ bị từ chối và invalid resume giữ interrupt pending.\n- State-operation policy gate vẫn có quyền allow/deny. Cleanup tài nguyên dùng defer/dispose; notification cuối không veto kết quả đã commit.\n`;
doc = doc.replace('2026-10-26', '2026-10-27');
write("docs/plugin-api-and-events.md", doc);
console.log(`Synchronized public declarations and ${count} built-in hook use cases.`);
