import { readFileSync, writeFileSync } from "node:fs";
// One-off synchronization of the reviewed public declaration excerpts.
const file = "docs/api-review.md";
let doc = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
function replace(before, after) {
  if (!doc.includes(before)) throw Error("Missing documentation anchor: " + before.slice(0, 70));
  doc = doc.replace(before, after);
}
function declaration(path, name) {
  const source = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
  const pattern = new RegExp("(?:^|\\n)(export (?:declare )?(?:class|interface|type|const) " + name + "\\b[\\s\\S]*?)(?=\\n(?:export |declare |interface |type |/\\*\\*)|$)");
  const match = source.match(pattern);
  if (!match) throw Error("Missing declaration " + name);
  return match[1].trimEnd().replace(/^    (?:private |protected |#private;).*\n/gm, "");
}
function updateDeclaration(path, name) {
  const pattern = new RegExp("export (?:declare class|interface) " + name + "[\\s\\S]*?\\n}");
  if (!pattern.test(doc)) throw Error("Missing documented declaration: " + name);
  doc = doc.replace(pattern, () => declaration(path, name));
}
replace("2026-10-21", "2026-10-25");
replace("LoggerPlugin, LoggerOptions, LogEntry; default export", "LoggerPlugin, FileTransport, ConsoleTransport, logGroup và các type logger; default export");
replace("| `@tessar/sqlite` |", "| `@tessar/opentelemetry` | OpenTelemetryPlugin, OTLPAdapter, LangfuseAdapter, ArizeAdapter, TraceloopAdapter và các type cấu hình |\n| `@tessar/sqlite` |");
replace("discover/load/install/update/remove/dispose, setup/write", "discover/load/install/update/remove/dispose, setup; transports.write/close");
replace("new OpenAIPlugin(options: OpenAIOptions)", "new OpenAIPlugin(options: OpenAIPluginOptions)");
replace("**Hiện tại plugin này dùng Responses adapter**, không nhận `model`, `api`, temperature hoặc reasoning như constructor OpenAIProvider. Đây là khác biệt thực tế cần nghiệm thu; không mô tả hai constructor là tương đương.", "Plugin dùng chung OpenAIProvider, nhận protocol, connection và native options tương ứng, bỏ field `model` vì factory chọn model theo request. Ví dụ `new OpenAIPlugin({ api: \"chat-completions\", connectionId: \"gateway\", temperature: 0.2 })`. Cùng provider ID chỉ đăng ký một lần; không gắn thêm plugin trùng provider của Agent.");
replace("Runtime lấy các Tool bằng `Object.values()`; **key `search` hiện chưa thay thế `searchTool.name`**. Tool name trùng bị từ chối.", "Object key là tên đăng ký: `search_web: searchTool` dùng `search_web` trong provider description, dispatch và history. Hai alias khác nhau có thể dùng cùng Tool; Tool gốc không bị đổi. Tool đăng ký qua plugin dùng tên trong Tool và cùng giữ schema identity để kiểm tra resume.");
replace("`new LoggerPlugin(options?: { write?: (entry: LogEntry) => void | Promise<void> })`.", "`new LoggerPlugin(options?: LoggerOptions)` với `{ level?: LogLevel; transports?: readonly LogTransport[] }`.");
replace("Mặc định ghi JSON qua console.error. `write` là callback, không phải path. LogEntry có EventContext cùng `level: \"info\" | \"warn\" | \"error\"`, `type`, `timestamp`, `payload`. Default export ở subpath là instance đã tạo; named class dùng với new.", "Mặc định level `info`, dùng ConsoleTransport ghi JSON qua stderr. LogLevel gồm `debug`, `info`, `warn`, `error`. `LoggerOptions` không có callback `write`; destination implement `LogTransport.write(entry)` và optional `close()`. `new FileTransport({ path, groupBy? })` ghi JSON Lines, `path` là filename; `logGroup.none` mặc định dùng một file, `thread`/`session`/`stream` nhóm theo identity, thiếu identity thì fallback về path. LogEntry dùng timestamp của event. Default export ở subpath là instance đã tạo; named class dùng với new.");
replace("## 15. Storage", "### OpenTelemetryPlugin\n\n`new OpenTelemetryPlugin(options: OpenTelemetryOptions)`; `.id = \"opentelemetry\"`, `.setup(tessar): Promise<void>`. `adapters` bắt buộc là mảng không rỗng các TraceAdapter; `realtime?: boolean` mặc định false, `serviceName?`, `traceName?`, `tags?: readonly string[]`. Mỗi adapter có `createExporter(): SpanExporter`; OTLPAdapter còn có protected `mapSpan` cho lớp kế thừa.\n\nAdapter constructors nhận optional options: OTLP `{ endpoint?, headers? }`; Langfuse `{ publicKey?, secretKey?, baseUrl?, prompt?: { name, version } }`; Arize `{ apiKey?, spaceId?, projectName?, endpoint? }`; Traceloop `{ apiKey?, endpoint? }`. Credentials có thể lấy từ environment; xem [guide](../examples/guide/opentelemetry.md).\n\nMỗi invocation/followUp có trace mới với Agent root. Langfuse Session nhóm theo Thread ID; Tessar Session ID giữ trong metadata. Resume/recover tạo segment mới, không tái sử dụng span đã đóng. `realtime: true` gửi mỗi span đã hoàn thành qua native SimpleSpanProcessor; không gửi token hoặc span đang chạy. Mặc định native batching; disposal flush các export đang chờ.\n\n## 15. Storage");
replace("Các dòng này ghi nhận code hiện tại, chưa tự sửa trong công việc viết tài liệu:", "Các dòng này ghi nhận contract hiện tại sau đợt sửa tính nhất quán ngày 2026-10-25:");
replace("- **Alias tool:** object key trong option `tools` của constructor Agent chưa đổi Tool.name. Ví dụ `search_web: searchTool` vẫn dùng `searchTool.name`.", "- **Alias tool:** object key quyết định tên đăng ký, không mutate Tool gốc. Agent và plugin đều giữ schema identity khi resume.");
replace("- **Provider plugin:** OpenAIPlugin chỉ Responses và client options; OpenAIProvider hỗ trợ chọn protocol và body options.", "- **Provider plugin:** OpenAIPlugin và OpenAIProvider dùng chung protocol/native options. Session giữ executable named connection trong runtime; restart phải đăng ký lại binding có cùng ID và descriptor.");
replace("- **Event:** `.is()` vẫn tồn tại", "- **Event:** mỗi envelope có timestamp phát event; lifecycle Stream/Turn/model/tool có record startedAt/endedAt. stream.error tới cả hooks và consumer, phân biệt target execution/consumer. `.is()` vẫn tồn tại");
replace("### Logger types\n\nNguồn: [packages/plugins/src/logger.ts](packages/plugins/src/logger.ts).", "### Logger types\n\nNguồn: `packages/plugins/src/build-in/logger.ts` và `logger-transports.ts`.");
const loggerNames = ["LogLevel", "LogEntry", "LoggerOptions"];
const transportNames = ["LogTransport", "logGroup", "LogGroup", "FileTransportOptions", "ConsoleTransport", "FileTransport"];
const loggerCode = [...loggerNames.map(name => declaration("packages/plugins/dist/build-in/logger.d.ts", name)), ...transportNames.map(name => declaration("packages/plugins/dist/build-in/logger-transports.d.ts", name))].join("\n\n");
doc = doc.replace(/(### Logger types[\s\S]*?```ts\n)[\s\S]*?\n```/, (_, prefix) => prefix + loggerCode + "\n```");
updateDeclaration("packages/core/dist/events/definition.d.ts", "EventEnvelope");
updateDeclaration("packages/core/dist/events/type.d.ts", "StreamOutcome");
updateDeclaration("packages/openai/dist/plugin.d.ts", "OpenAIPlugin");
const eventSource = readFileSync("packages/core/dist/events/type.d.ts", "utf8").replaceAll("\r\n", "\n");
const module = eventSource.match(/declare module "\.\/definition.js" \{[\s\S]*?\n}/)?.[0];
if (!module) throw Error("Missing current EventMap");
doc = doc.replace(/declare module "\.\/definition.js" \{[\s\S]*?\n}/, () => module);
replace("### OpenAIPlugin\n\n```ts\nexport declare class", "### OpenAIPlugin\n\n```ts\n" + declaration("packages/openai/dist/plugin.d.ts", "OpenAIPluginOptions") + "\n\nexport declare class");
doc = doc.replaceAll("Extract<M, ModelAdapter>", "M extends ModelAdapter ? M : ModelAdapter");
writeFileSync(file, doc);
