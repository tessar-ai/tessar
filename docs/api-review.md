# Tessar — Danh mục API public để nghiệm thu

Ngày đối chiếu: **2026-10-25**. Nguồn: code, `package.json#exports` và declaration sau build trong checkout hiện tại. Đây là **hành vi đang được triển khai**, không phải bản thiết kế đề xuất và không khẳng định bản trên npm đã có các thay đổi này.

`?` nghĩa là optional; field không có `?` là bắt buộc. `readonly` là hợp đồng TypeScript; không đồng nghĩa mọi object đều được freeze lúc chạy. Các kiểu dữ liệu đầy đủ nằm trong phụ lục cuối file, gồm cả kiểu của callback và kết quả.

Danh mục gồm API ứng dụng, API viết plugin/provider/storage và các subpath testing được publish. Không đưa các class điều phối runtime nội bộ vào danh mục sử dụng. Phụ lục có chữ ký class public đã loại thành viên private/internal, bên cạnh các type và callback đầy đủ.

### Quy tắc sau rà soát

- Thao tác đọc cấu hình/state trên runtime dùng method: `getInstruction()`, `getModel()`, `listTool()`, `limits()`, `scope()`, `metadata()`, `profile()`.
- Identity cố định và liên kết đối tượng readonly giữ dạng dữ liệu: `id`, `controller.agent`, `session.agent`, `session.controller`.
- Namespace giữ dạng nhóm API: `session.model`, `session.thread`, `controller.plugins`, các nhóm trên PluginContext; thao tác bên trong là method.
- Message, event, record, result, model connection descriptor và tool definition giữ field dữ liệu. Ví dụ `event.type`, `message.content`, `result.output`, `provider.ref`, `provider.options`, `tool.name` không phải các getter runtime được đổi ở trên.
- Field private của TypeScript không thuộc hợp đồng public, nhưng không chặn JavaScript truy cập runtime như `#private`. Các field cũ của Agent không được giữ như alias public; TypeScript dùng method. Không coi `private` là sandbox hoặc cơ chế bảo mật.

## Mục lục

1. [Import từ package nào](#1-import-từ-package-nào)
2. [Provider OpenAI](#2-provider-openai)
3. [Agent](#3-agent)
4. [Stream và generate](#4-stream-và-generate)
5. [Controller](#5-controller)
6. [Session](#6-session)
7. [Session.model](#7-sessionmodel)
8. [Session.thread và Thread](#8-sessionthread-và-thread)
9. [Message](#9-message)
10. [Instruction](#10-instruction)
11. [Tool](#11-tool)
12. [Plugin và hook](#12-plugin-và-hook)
13. [State, effect, interruption và lời gọi phụ](#13-state-effect-interruption-và-lời-gọi-phụ)
14. [PluginManager và logger](#14-pluginmanager-và-logger)
15. [Storage](#15-storage)
16. [Model profile và provider tự viết](#16-model-profile-và-provider-tự-viết)
17. [Hàm nền tảng được export](#17-hàm-nền-tảng-được-export)
18. [Testing SDK](#18-testing-sdk)
19. [Điểm cần nghiệm thu](#19-điểm-cần-nghiệm-thu)
20. [Chữ ký và kiểu dữ liệu đầy đủ](#20-chữ-ký-và-kiểu-dữ-liệu-đầy-đủ)

## 1. Import từ package nào

| Import | API |
| --- | --- |
| `@tessar/core` | Agent, Controller, Session, Thread, messages, instructions, tools, hooks, hợp đồng model/state/storage và các hàm nền tảng |
| `@tessar/core/tool` | Tool, createTool, ToolSuspension và các type tool; cùng implementation với root |
| `@tessar/core/testing` | ScriptedProvider, AgentHarness, ModelScript |
| `@tessar/core/testing/storage-conformance` | initialBatch, storageConformance |
| `@tessar/openai` | OpenAIProvider, OpenAIPlugin và các type cấu hình |
| `@tessar/plugins` | PluginManager, PluginManagerOptions |
| `@tessar/plugins/logger` | LoggerPlugin, FileTransport, ConsoleTransport, logGroup và các type logger; default export là một instance logger |
| `@tessar/opentelemetry` | OpenTelemetryPlugin, OTLPAdapter, LangfuseAdapter, LaminarAdapter và các type cấu hình |
| `@tessar/sqlite` | SqliteStoragePlugin, createSqliteBackend, SqliteStorageOptions |
| `@tessar/postgresql` | PostgresqlStoragePlugin, createPostgresqlBackend, PostgresqlStorageOptions |
| `@tessar/mongodb` | MongoDBStoragePlugin, createMongoDBBackend, MongoDBStorageOptions |

### Phạm vi đã đối chiếu

| Nhóm API | Constructor / tạo đối tượng | Method / callback | Dữ liệu và namespace giữ property |
| --- | --- | --- | --- |
| Agent | `new Agent(options)` | getModel, getInstruction, listTool, limits, stream, generate, resume, sendSignal, shutdown | id |
| Controller | `new Controller(options)` | initialize, dispose, createSession, getSession, listSessions, plugins.attach/detach | id, agent, plugins |
| Session | Controller tạo/khôi phục | scope, metadata, subscribe, followUp, resume, recover, abort, dispose, model manager, thread manager | id, agent, controller, model/thread namespace |
| Thread | Session.thread tạo/lấy/fork | scope, snapshot, history/checkpoint/trace/interrupt reads, dispose | id |
| Message / Event | Constructors và MessageCodec | normalizeContent, encode/decode | Các field message/event và event map |
| Instruction / Tool | buildInstruction, normalizeInstruction, createTool/new Tool, ToolSuspension | execute/resume, emit/suspend, recovery callbacks | Sections, schema, tool definition và identity |
| Provider / Model | OpenAIProvider, provider registration factory | profile, refreshProfile, withModel, validate, stream | ref, connection, options, api và các metadata DTO |
| ProfileResolver | `new ProfileResolver(options?)` | current, resolve, needsRefresh, clear | Không expose cache/catalog implementation |
| Plugin authoring | Class implements Plugin | setup, registration, hook, emit, defer, state/effect/interrupt/child/auxiliary APIs | Plugin identity, capability namespaces và context data |
| Plugin distribution / logger | PluginManager, LoggerPlugin | discover/load/install/update/remove/dispose, setup; transports.write/close | directory bất biến, plugin id, LogEntry |
| Storage | Ba storage plugin, ba backend factory, createMemoryBackend | setup, các StorageBackend port và close | Backend identity/capabilities, Session/checkpoint/trace DTO |
| Foundation / testing | Error constructors, ScriptedProvider, AgentHarness factory | JSON/scope/paging/usage helpers, harness và conformance methods | Type contracts, metrics, fixture data |

Đây là đối chiếu toàn bộ entrypoint, constructors, methods, thuộc tính dữ liệu/namespace, callback và type public; không chỉ một nhóm getter. Chữ ký cụ thể của từng nhóm nằm bên dưới.

## 2. Provider OpenAI

```ts
import { OpenAIProvider } from "@tessar/openai";

const model = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-6.1-sol",
  reasoning: { effort: "high" },
  max_output_tokens: 8192,
});
```

### Constructor

`new OpenAIProvider(configuration)` nhận một object phẳng:

| Parameter | Kiểu | Mặc định / ý nghĩa |
| --- | --- | --- |
| `model` | `string` | Bắt buộc; native model ID |
| `api?` | `"responses" \| "chat-completions"` | Tessar chọn `"responses"` khi bỏ trống |
| `providerId?` | `string` | `"openai"`; có thể dùng ID khác cho gateway/kết nối khác |
| `connectionId?` | `string` | Tessar sinh UUID nếu không khai báo; dùng ID ổn định khi cần khôi phục kết nối qua restart |
| `metadataPartition?` | `string` | Phân vùng metadata; mặc định theo identity của kết nối |
| Các field client | `OpenAIOptions` kế thừa SDK `ClientOptions` | Xem danh sách đầy đủ bên dưới |
| Các field request | `OpenAIModelOptions` hoặc `OpenAIChatModelOptions` | Theo protocol đã chọn; xem danh sách đầy đủ bên dưới |

Tessar tách field client khỏi body request, snapshot các field request đã khai báo và không tự thêm temperature/reasoning/max token. **OpenAI SDK vẫn có default riêng**, ví dụ retry; điều đó khác với việc Tessar tự thêm tham số vào body.

Toàn bộ field client và body được chép từ declaration của **OpenAI SDK 7.34.0 đang cài trong repo** ở phần phụ lục provider. Type mang tên `OpenAI.*`, `Shared.*`, `ClientOptions.*` hoặc `SDK.*` là type của dependency, không phải thêm một lớp config của Tessar.

### Thành viên trên provider

| API | Parameter | Trả về / ý nghĩa |
| --- | --- | --- |
| `.ref` | — | `ModelRef`: providerId, modelId, connectionId |
| `.connection` | — | `ModelConnectionDescriptor \| undefined`: identity không chứa secret |
| `.options` | — | Object option request đã snapshot, readonly |
| `.api` | — | Protocol đang dùng |
| `.profile()` | Không có | `Readonly<ModelProfile>`; snapshot metadata hiện tại |
| `.withModel(modelId)` | `modelId: string` | Provider mới dùng chung kết nối/client và defaults, đổi native model ID |
| `.refreshProfile(options?)` | `{ signal?: AbortSignal }` | `Promise<ModelProfile>` |
| `.validate(request)` | `request: ModelRequest` | `void`; hợp đồng provider cho runtime/custom integration |
| `.stream(request, context)` | `request: ModelRequest`, `context: { signal: AbortSignal }` | `AsyncIterable<ModelChunk>`; stream provider chuẩn hóa, khác Agent stream |

### Những field bị runtime giữ quyền

Responses loại khỏi type cấu hình model: `model`, `input`, `instructions`, `tools`, `stream`, `background`, `conversation`, `previous_response_id`, `context_management`. Field `model` được khai báo riêng ở constructor. Cấu hình background/provider-managed conversation/compaction không được loop hỗ trợ.

Chat Completions loại khỏi type cấu hình model: `model`, `messages`, `tools`, `stream`, `functions`, `function_call`, `n`; thêm lại `n?: 1`. Runtime chỉ nhận một choice.

Các codec vẫn kiểm tra loại content/tool/continuity được hỗ trợ. Có field trong SDK type không có nghĩa mọi combination hoặc output modality đều được Tessar loop hỗ trợ.

### OpenAIPlugin

```ts
new OpenAIPlugin(options: OpenAIPluginOptions)
```

`options` bắt buộc là object, có thể dùng các field client ở phụ lục cùng `providerId?`, `metadataPartition?`. `.id` là `"provider." + providerId`; `.setup(tessar: PluginContext): void` đăng ký provider.

Plugin dùng chung OpenAIProvider, nhận protocol, connection và native options tương ứng, bỏ field `model` vì factory chọn model theo request. Ví dụ `new OpenAIPlugin({ api: "chat-completions", connectionId: "gateway", temperature: 0.2 })`. Cùng provider ID chỉ đăng ký một lần; không gắn thêm plugin trùng provider của Agent.

## 3. Agent

```ts
const agent = new Agent({
  id: "assistant",
  model,
  instructions: "You are helpful.",
  tools: { search: searchTool },
});
```

### `new Agent(options)`

| Field | Kiểu | Mặc định / ràng buộc |
| --- | --- | --- |
| `id` | `string` | Dev đặt; không rỗng; không trùng Agent đang sống trong cùng loaded core runtime |
| `model` | `ModelAdapter \| Model \| ModelRef` | Bắt buộc. Muốn chạy độc lập phải có adapter executable; ModelRef cần provider được đăng ký qua Controller |
| `instructions?` | `string \| Instruction` | Normalize từ chuỗi rỗng nếu bỏ qua |
| `tools?` | `AgentTools` | Object chứa Tool; mặc định không có tool |
| `limits?` | `Partial<StreamLimits>` | `maxTurns: 32`, `maxModelAttempts: 64`, `maxToolCalls: 128`; mỗi giá trị phải là số nguyên dương |

`AgentTools` hiện có `concurrency?: number` và các key tool. Bỏ concurrency thì không giới hạn số tool chạy đồng thời; khai báo thì phải là số nguyên dương. Object key là tên đăng ký: `search_web: searchTool` dùng `search_web` trong provider description, dispatch và history. Hai alias khác nhau có thể dùng cùng Tool; Tool gốc không bị đổi. Tool đăng ký qua plugin dùng tên trong Tool và cùng giữ schema identity để kiểm tra resume.

### Thành viên ứng dụng

| API / thuộc tính | Parameter | Trả về |
| --- | --- | --- |
| `.id` | — | `string` |
| `.limits()` | Không có | StreamLimits có default; override theo execution không sửa giá trị này |
| `.listTool()` | Không có | `readonly Tool[]`; tool cấu hình trên Agent, trước selection/plugin theo execution |
| `.getModel()` | Không có | Model mặc định, giữ kiểu generic từ constructor |
| `.getInstruction()` | Không có | `Instruction` nền, trước hook |
| `.stream(input, options?)` | Phần 4 | `Stream` |
| `.generate(input, options?)` | Phần 4 | `Promise<GenerateOutcome>` |
| `.resume(options)` | Bảng dưới | `Stream` tiếp tục execution suspended |
| `.sendSignal(options)` | `SendSignalOptions`; bảng dưới | `Promise<void>`; xác nhận đã nhận, không phải kết quả model |
| `.shutdown()` | Không có | `Promise<void>`; kết thúc tài nguyên/lifecycle của Agent |

Đọc cấu hình qua `getModel()`, `listTool()`, `getInstruction()`, `limits()`. Các field lưu trữ là private, không phải API thuộc tính public. Constructor vẫn nhận `model`, `tools`, `instructions`, `limits` như bảng options phía trên. TypeScript từ chối đọc field private; code JavaScript không được đảm bảo bị chặn ở runtime vì implementation dùng `private`, không dùng `#private`.

### `agent.resume(options)`

| Field | Kiểu | Ý nghĩa |
| --- | --- | --- |
| `threadId` | `string` | Thread của execution chờ |
| `interruptId` | `string` | ID từ interruption |
| `value` | `JsonValue` | Câu trả lời user/approval |
| `scope?` | `Scope` | Kiểm tra phạm vi thread |
| `signal?` | `AbortSignal` | Hủy lần tiếp tục |

Agent trực tiếp không có API public `initialize()` hay `recover()`. Constructor và getters không yêu cầu Controller. Khi Agent đã gắn Controller, stream/generate dùng runtime/plugin của Controller mà không bắt buộc tạo Session.

### `agent.sendSignal(options)`

| Field | Kiểu | Ý nghĩa |
| --- | --- | --- |
| `streamId` hoặc `threadId` | `string`; bắt buộc đúng một | Stream trực tiếp dùng `stream.id`; Session dùng `session.thread.getId()` |
| `content` | `string \| readonly ContentPart[]` | Bắt buộc; tạo message role user, không nhận option role |
| `persist?` | `boolean` | Mặc định true; lưu pending input trước khi áp dụng vào context. False giữ input trong execution ở RAM |
| `tagName?` | `string` | Bọc XML; tên theo `[A-Za-z_][A-Za-z0-9_.-]*` |
| `attributes?` | `Record<string, string \| number \| boolean>` | Cần tagName, kiểm tra tên/giá trị và escape attribute |
| `metadata?` | `JsonObject` | Metadata ứng dụng; không gửi provider |

Signal không hủy bước hiện tại, chèn trước request model tiếp theo sau toàn bộ tool results. Pending input giữ execution tiếp tục cùng Stream.id. Thread rảnh bắt đầu qua Session đang chọn nó, dùng model/options và subscription hiện có. Thread suspended nhận pending input nhưng vẫn phải resume; signal không tự trả lời interruption.

`await sendSignal()` xác nhận input đã được nhận vào RAM như `followUp()`, không đợi admission, checkpoint, callback plugin hay kết quả model. Persist true ghi pending input trước khi áp dụng vào context; input chưa ghi có thể mất nếu process tắt. Lỗi xử lý/ghi sau khi nhận đi qua event execution và diagnostics. Hook chuẩn bị có thể gọi và await signal mà không chặn chính bước chuẩn bị đó.

Persist false giữ input qua các vòng model/tool và resume trong cùng process, không lưu input vào checkpoint/history và mất sau restart/kết thúc execution; output model/tool vẫn lưu bình thường. Persist true dùng backend đang cấu hình (standalone mặc định RAM). Hủy, policy stop và limits giữ ưu tiên. Target không hợp lệ/Stream đã kết thúc, Thread chưa được chọn, Session stale hoặc ownership không rõ bị từ chối. Thread target tới lúc lượt cũ đang kết thúc được Session nhận để bắt đầu sau khi lượt cũ đóng. Không có session.sendSignal, Stream.sendSignal hay runId.

## 4. Stream và generate

### Parameter chung

```ts
agent.stream(input, options?);
await agent.generate(input, options?);
```

`input` bắt buộc là `string | MessageData | readonly MessageData[]`. Chuỗi được chuyển thành HumanMessage; có thể truyền nhiều message để tự dựng context. Mỗi lời gọi trực tiếp khởi tạo execution/thread mới, không tự nối hội thoại lần gọi trước.

| `options` field | Kiểu | Ý nghĩa |
| --- | --- | --- |
| `id?` | `string` | Chỉ `stream()`: dev đặt Stream ID; Tessar sinh khi bỏ qua |
| `model?` | `ModelAdapter \| Model \| ModelRef \| string` | Override model cho execution. String đổi native model trên adapter/kết nối hiện tại; đổi provider/kết nối dùng đối tượng tương ứng |
| `modelOptions?` | `ModelOptions<M>` | Shallow override defaults của model được chọn; object con được thay nguyên object |
| `scope?` | `Scope` | Scope state của execution trực tiếp |
| `context?` | `JsonObject` | Dữ liệu app đưa vào execution hook context; không tự thành message gửi provider |
| `signal?` | `AbortSignal` | Hủy execution; không dùng để truyền message |
| `limits?` | `Partial<StreamLimits>` | Override giới hạn của execution |

```ts
for await (const event of agent.stream([
  new HumanMessage("Tôi tên An"),
  new AssistantMessage("Chào An"),
  new HumanMessage("Tôi tên gì?"),
], {
  model: "gpt-6-astra",
  modelOptions: { reasoning: { effort: "high" } },
})) {
  if (event.type === text.delta) console.log(event.payload.delta);
}
```

### Stream handle

| Thành viên | Kiểu / parameter | Ý nghĩa |
| --- | --- | --- |
| `.id` | `string \| null` | ID execution; có ngay với input mới; resume có sau khi đọc execution cũ |
| `.threadId` | `string` | Thread ID |
| `.handleId` | `string` | ID attachment hiện tại |
| `.abort(reason?)` | `reason?: string` → `void` | Yêu cầu hủy |
| `[Symbol.asyncIterator]()` | Không có → async iterator `StreamEvent` | Một iterator consumer; có thể dùng `for await` |

Stream không có `.result`, `.output`, `.status` hay `.subscribe`. Kết quả cuối xem payload event `stream.end`; suspension xem `stream.suspended`.

### Kết quả generate

`GenerateOutcome` có **`threadId`, `streamId`, `status`, `output`, `usage`, `interrupt`, `error`**. `output` là `readonly MessageData[]`, không phải string. `status` thuộc `StreamStatus`; `interrupt` và `error` có thể null.

`Stream.id` giữ nguyên ý nghĩa ID execution hiện có. `streamId` trong generate result, event, context và persistence tham chiếu cùng ID đó. Resume tiếp tục execution cũ. Stream chỉ có `.abort(reason?)` để hủy, không expose `.signal`; nhận input ngoài qua `agent.sendSignal()`.

`generate()` thu stream đến kết quả trả về. Lỗi runtime/provider đi qua đường thất bại có thể làm Promise reject; không dựa riêng vào `result.error` để bắt mọi lỗi. Suspend có thể trả outcome `status: "suspended"` để UI hỏi user rồi gọi `agent.resume()`.

## 5. Controller

### `new Controller(options)`

| Field | Kiểu | Ý nghĩa |
| --- | --- | --- |
| `id` | `string` | Dev đặt; không rỗng; không trùng Controller đang sống |
| `agent` | `Agent` | Agent gắn runtime này |
| `plugins?` | `readonly Plugin[]` | Plugin ban đầu; mặc định `[]` |

| API | Parameter | Trả về / ý nghĩa |
| --- | --- | --- |
| `.id`, `.agent` | — | Identity và Agent |
| `.initialize()` | Không có | `Promise<void>`; setup plugin/storage/provider trước sử dụng runtime |
| `.dispose()` | Không có | `Promise<void>`; đóng runtime và tài nguyên |
| `.plugins.attach(plugin)` | `plugin: Plugin` | `Promise<void>`; thêm plugin khi ready |
| `.plugins.detach(id)` | `id: string` | `Promise<void>`; ngừng cấp plugin cho execution mới; cleanup có thể chờ execution đang giữ registration kết thúc; storage không được detach khi ready |
| `.createSession(options?)` | `SessionOptions` | `Promise<Session>`; sinh và lưu Session |
| `.getSession(id, query?)` | `id: string`, `query?: { scope?: Scope }` | `Promise<Session \| null>` |
| `.listSessions(query?)` | `query?: StateQuery & PageOptions` | `Promise<Page<SessionRecord>>`; lọc theo Agent của Controller |

`SessionOptions`: `{ id?: string; threadId?: string; scope?: Scope; model?: Model | ModelRef; metadata?: JsonObject }`. Model mặc định lấy từ Agent; metadata mặc định `{}`. ID bỏ qua thì tự sinh; truyền ID đã tồn tại bị từ chối. threadId tạo và chọn Thread mới; không có `instructions` trong options này.

Đã xóa `.models` và các method `.createThread()`, `.getThread()`, `.listThreads()`, `.renameThread()`, `.forkThread()`, `.deleteThread()`, `.purgeThread()` khỏi class Controller; không giữ bản private hoặc alias của các API này. Dev dùng `session.model` và `session.thread`.

Runtime vẫn cần registry provider riêng và các hàm truy cập state dùng chung. Ví dụ `controller.getSession()` gọi hàm nội bộ để đọc thread đã chọn trong record khi khôi phục Session. Hàm đó nằm ngoài class Controller; không phải một method quản lý thread trên Controller.

## 6. Session

Nhận Session từ `controller.createSession()` hoặc `controller.getSession()`. `session.id` do dev đặt hoặc tự sinh, được lưu persistent; `session.scope()` trả scope cố định theo record. Constructor Session không public.

| API / thuộc tính | Parameter | Trả về / ý nghĩa |
| --- | --- | --- |
| `.id` | — | `string` |
| `.scope()` | Không có | `Scope` |
| `.metadata()` | Không có | `JsonObject` |
| `.agent`, `.controller` | — | Đối tượng gắn với phiên |
| `.subscribe(observer)` | `(event: StreamEvent) => unknown` | `() => void` để hủy subscription |
| `.subscribe(name, observer)` | `name: AnyEvent`, callback nhận envelope đúng payload event | `() => void` |
| `.followUp(input)` | `string \| MessageData \| readonly MessageData[]` | `Promise<QueuedInputReceipt>`; nhận/xếp hàng input, chưa phải kết quả model |
| `.followUp.count()` | Không có | `number`; input đang chờ, không tính execution hiện tại |
| `.followUp.isEmpty()` | Không có | `boolean`; hàng đợi trống |
| `.state.get()` | Không có | `RuntimeState`; snapshot render bất biến trong RAM |
| `.isIdle()` | Không có | `boolean`; không có execution đang chạy hoặc input đang xếp hàng; suspended không có queue cũng idle |
| `.isDisposed()` | Không có | `boolean`; handle đã đóng |
| `.resume(options)` | `{ interruptId: string; value: JsonValue; model?: Model \| ModelRef }` | `Promise<ExecutionReceipt>`; admission của phần tiếp tục |
| `.recover(options)` | `{ streamId: string; model?: Model \| ModelRef }` | `Promise<ExecutionReceipt>`; tiếp quản execution đã lưu |
| `.abort(reason?)` | `reason?: string`, mặc định `"Cancelled"` | `Promise<void>` |
| `.dispose()` | Không có | `Promise<void>`; đóng handle, giữ record; active work phải được xử lý trước |
| `.model` | Phần 7 | Quản lý lựa chọn model |
| `.thread` | Phần 8 | Quản lý thread trong scope |

`QueuedInputReceipt = { id: string; threadId: string }`.
`ExecutionReceipt = { streamId: string; threadId: string }`.

`createSession({ threadId, scope })` tạo và chọn Thread mới với ID được cung cấp,
kế thừa scope. Trùng ID báo lỗi; muốn chọn Thread có sẵn dùng `session.thread.switch()`.
`controller.isReady(): boolean` đọc lifecycle hiện tại.

`stateChanged` là event string `"state_changed"`, payload `{ state: RuntimeState }`.
Agent.stream phát snapshot theo từng stream; Session.subscribe phát snapshot hội thoại
qua nhiều lượt, với `queuedInputs` của phiên. `session.state.get()` trả snapshot hiện tại.
Snapshot có `status`, `messages` (gồm draft), `currentMessage`, `tools`, `interrupt`,
`queuedInputs`, `error`. ID thread/stream nằm trên event, không lặp trong state.
Getter không đọc DB, event snapshot không ghi checkpoint; phần message/tool progress
chưa commit chỉ ở RAM. Chọn/khôi phục Thread nạp dữ liệu bền vững một lần.
Client SDK application được hoãn tại [TD-002](docs/technical-debt.md).

`followUp(text)` tự tạo `HumanMessage`; vẫn nhận message hoặc mảng message khi cần metadata hay multipart content. Không nhận options model, context hay AbortSignal. Một Session có một foreground execution; follow-up queue chưa admission nằm trong RAM. `resume/recover` trả receipt, các event/kết quả tiếp tục đến subscription. `.subscribe()` không phải API đăng ký hook điều khiển policy.

## 7. Session.model

| API | Parameter | Trả về / ý nghĩa |
| --- | --- | --- |
| `.get()` | Không có | `string`: ID đầy đủ `providerId/modelId` |
| `.name()` | Không có | `string`: native model ID, có thể chứa slash |
| `.info()` | Không có | Snapshot immutable `{ id, name, profile, options? }` của model đang chọn |
| `.setEffort(level)` | `level: string` | `Promise<void>`; adapter ánh xạ sang native options và giữ các options khác |
| `.list()` | Không có | `readonly SessionModelInfo[]`: `{ id, name, profile }` từ catalog của provider đã đăng ký, gồm model đang chọn |
| `.switch(modelId, options?)` | `modelId: string`, `options?: JsonObject` | `Promise<void>` |

ID đầy đủ chọn provider đã đăng ký; bare ID không có slash giữ provider và connection hiện tại. Model có native ID chứa slash dùng full ID để tránh nhập nhằng.

Mỗi switch dùng defaults của adapter đích cộng shallow override lần gọi này; bỏ overrides Session trước đó. Không truyền options thì trở về defaults đích. Cấm transport/runtime-owned fields như apiKey/baseURL/defaultHeaders/maxRetries/timeout/model/input/tools/stream trong options.

Đổi model ảnh hưởng input được nhận sau switch. Input đã nhận/xếp hàng giữ snapshot model/options riêng. Trước đổi có `session.model.beforeChange`, sau khi lưu thành công có `session.modelChanged` khi đổi model/connection và `session.model.optionsChanged` khi options thay đổi. Options event chứa `model`, `previousOptions?`, `options?`; no-op không phát event. `setEffort(level)` giữ các options hiện tại; provider không hỗ trợ sẽ báo `UnsupportedOption`.

Không có `.set()` hoặc `session.setModel()`.

## 8. Session.thread và Thread

### Manager `session.thread`

| API | Parameter | Trả về |
| --- | --- | --- |
| `.create(options?)` | `{ id?: string; title?: string; messages?: readonly MessageData[]; metadata?: JsonObject }` | `Promise<Thread>`; ID dev đặt hoặc tự sinh, kế thừa scope, chọn thread mới |
| `.getId()` | Không có | `string \| null` |
| `.get(id)` | `id: string` | `Promise<Thread \| null>`; lọc scope |
| `.list(options?)` | `PageOptions` | `Promise<Page<ThreadInfo>>`; các thread trong scope |
| `.switch(id)` | `id: string` | `Promise<Thread>`; lưu lựa chọn |
| `.rename(title, target?)` | `title: string`, `target?: { threadId?: string }` | `Promise<void>` |
| `.fork(options?)` | `{ id?: string; atCheckpointId?: string; atMessageId?: string; metadata?: JsonObject; threadId?: string }` | `Promise<Thread>`; `id` của đích, `threadId` chọn nguồn; không tự switch |
| `.delete(target?)` | `{ threadId?: string }` | `Promise<void>`; soft delete |
| `.purge(target?)` | `{ threadId?: string }` | `Promise<void>`; xóa vĩnh viễn thread đã soft-delete |
| `.getHistory(options?)` | `{ cursor?: string; limit?: number; atCheckpointId?: string; threadId?: string }` | `Promise<HistoryPage>` |

`threadId` bỏ qua nghĩa là thread đang chọn. `.create()` không nhận `scope`, `instructions`. Create/switch bị từ chối khi có active work hoặc input xếp hàng. Fork chỉ chọn một trong `atCheckpointId`/`atMessageId`; điểm fork phải an toàn. Create/fork không thay thế Thread đã có cùng ID. Delete/purge giữ policy, ownership và CAS; purge cần thread inactive, unowned và không còn fork tham chiếu.

### Thread handle: API đọc

| API | Parameter | Trả về |
| --- | --- | --- |
| `.id` | — | `string` |
| `.scope()` | Không có | `Scope` |
| `.snapshot()` | Không có | `Promise<Checkpoint & { activeStreamId: string \| null; currentCheckpointId: string; usage: UsageSummary }>` |
| `.getHistory(options?)` | `HistoryOptions` | `Promise<HistoryPage>` |
| `.getCheckpoint(id)` | `id: string` | `Promise<Checkpoint \| null>` |
| `.listCheckpoints(options?)` | `PageOptions` | `Promise<Page<CheckpointInfo>>` |
| `.getStream(id)` | `id: string` | `Promise<StreamRecord \| null>` |
| `.listStreams(options?)` | `PageOptions` | `Promise<Page<StreamRecord>>` |
| `.listTurns(streamId, options?)` | `streamId: string`, `options?: PageOptions` | `Promise<Page<TurnRecord>>` |
| `.listModelAttempts(turnId, options?)` | `turnId: string`, `options?: PageOptions` | `Promise<Page<ModelAttemptRecord>>` |
| `.listToolExecutions(turnId, options?)` | `turnId: string`, `options?: PageOptions` | `Promise<Page<ToolExecutionRecord>>` |
| `.getInterrupt(id)` | `id: string` | `Promise<InterruptRecord \| null>` |
| `.listInterrupts(options?)` | `PageOptions & { status?: "pending" \| "resolved" \| "cancelled" }` | `Promise<Page<InterruptRecord>>` |
| `.dispose()` | Không có | `Promise<void>`; đóng handle |

`PageOptions = { cursor?: string; limit?: number }`: mặc định limit 50, hợp lệ 1–200. `Page<T> = { items: readonly T[]; nextCursor: string | null }`. `HistoryPage` thêm `checkpointId`, `revision`; items là Message. Scope lọc bằng các key/value đã truyền, không tự chứng thực người dùng.

Thread không có constructor public; lấy handle qua `session.thread`. Các method nội bộ để admit/stream/cancel execution không thuộc API Thread public.

## 9. Message

| Constructor | Parameter |
| --- | --- |
| `new HumanMessage(content, options?)` | `content: string \| readonly ContentPart[]`, `options?: MessageOptions`; role `user` |
| `new SystemMessage(content, options?)` | Tương tự; role `system` |
| `new AssistantMessage(content, options?)` | Tương tự; role `assistant` |
| `new ToolMessage(content, options?)` | Tương tự; `options` thêm `toolCallId?: string`; role `tool` |

`MessageOptions = { id?: string; metadata?: JsonObject; providerState?: JsonValue }`. Bỏ ID thì Tessar sinh ID. `Message` là abstract base class để đọc/kế thừa, không tạo trực tiếp.

Các thuộc tính đọc: `schemaVersion: 1`, `id`, `role`, `content`, `metadata?`, `providerState?`, `toolCallId?`. Hiện role không có `developer`.

ContentPart có các dạng: text, reasoning (có providerState?), tool-call (toolCallId/name/arguments), image/audio/file (mediaType/data), data (JsonValue). Mọi part nhận `metadata?: JsonObject`, độc lập với metadata cấp message. Core kiểm tra object JSON và bảo toàn dữ liệu qua codec/event/history/checkpoint; key và cách xử lý do dev/plugin quyết định. OpenAI adapters không gửi metadata này cho provider và không lọc nội dung theo metadata. Chi tiết schema ở phụ lục; từng provider kiểm tra khả năng encode.

| API | Parameter | Trả về |
| --- | --- | --- |
| `normalizeContent(content)` | `string \| readonly ContentPart[]` | `readonly ContentPart[]` |
| `MessageCodec.encode(message)` | `Message` hoặc MessageData tương thích cấu trúc | `MessageData` JSON, readonly snapshot |
| `MessageCodec.decode(data)` | `unknown` | `Message`; kiểm tra schema/role/ID |

ToolMessage trả từ tool có thể bỏ toolCallId; loop gắn ID tương ứng. Encode một message role tool để lưu/gửi độc lập cần toolCallId hợp lệ.

## 10. Instruction

| API | Parameter | Trả về |
| --- | --- | --- |
| `buildInstruction(sections)` | `readonly InstructionSection[]` | `Instruction` |
| `normalizeInstruction(value?)` | `string \| Instruction`; mặc định `""` | `Instruction` |

`InstructionSection = { readonly id: string; readonly content: string; readonly order?: number }`.
`Instruction = { readonly sections: readonly InstructionSection[] }`.

Order tăng dần, bỏ order so sánh như 0; bằng order thì so ID ordinal. ID section phải duy nhất, content phải là text, order hữu hạn. Plugin thêm section ở `context.prepare`; `provider.request` xử lý body sau adapter encode. Cách serialize system/instructions phụ thuộc provider.

## 11. Tool

```ts
import { createTool, ToolMessage } from "@tessar/core/tool";
import { z } from "zod";

const add = createTool({
  name: "add",
  description: "Add two numbers",
  schema: z.object({ a: z.number(), b: z.number() }),
  execute: ({ a, b }, context) => ({ sum: a + b }),
});
```

`createTool(definition)` và `new Tool(definition)` cùng nhận:

| Field | Kiểu / callback | Ý nghĩa |
| --- | --- | --- |
| `name` | `string` | Bắt buộc, không rỗng |
| `description` | `string` | Bắt buộc |
| `schema` | `z.ZodType<I>` | Bắt buộc; parse input và sinh JSON Schema |
| `execute` | `(input: I, context: ToolExecutionContext) => ToolResult \| Promise<ToolResult>` | Bắt buộc |
| `resumeSchema?` | `z.ZodType<R>` | Validate câu trả lời resume |
| `resume?` | `(response: R, input: I, context: ToolExecutionContext) => ToolResult \| Promise<ToolResult>` | Xử lý sau suspension; bỏ callback thì dùng response làm result |
| `recovery?` | `ToolRecovery<I>` | idempotencyKey và reconcile khi phục hồi external work |

`ToolOutput = JsonValue | ToolMessage`, `ToolResult = ToolOutput | ToolSuspension`.
`tool.execute()` trả Promise và normalize output thường thành ToolMessage; suspension giữ ToolSuspension. Không trả undefined. Chưa có `outputSchema`, `inputSchema`, `retry`, `enabled` hay `id` trong ToolDefinition.

Thuộc tính Tool: `name`, `description`, `schema`, `jsonSchema`, `execute`, `resumeSchema?`, `resumeJsonSchema`, `resume?`, `recovery?`, `configurationId`. `configurationId` là giá trị Tessar tạo từ schema để kiểm tra tương thích continuation.

### ToolExecutionContext

| Thành viên | Parameter / kiểu | Trả về |
| --- | --- | --- |
| `signal` | `AbortSignal` | Hủy execution |
| `threadId`, `streamId`, `turnId`, `toolExecutionId` | `string` | Identity |
| `emit(progress)` | `progress: JsonValue` | `void` |
| `suspend(payload)` | `payload: JsonValue` | `ToolSuspension` |
| `models`, `effects`, `executions`, `events` | TrackedServices ở phần 13 | Các dịch vụ plugin/tool dùng |

`new ToolSuspension(payload: JsonValue)` là API public; `.payload` readonly. `context.suspend(payload)` tạo giá trị này. UI nhận interrupt payload/responseSchema, UI gửi `value` qua Agent/Session resume. Tool không phải tự tìm/gắn toolCallId.

## 12. Plugin và hook

### Hợp đồng Plugin

```ts
interface Plugin {
  readonly id: string;
  readonly version?: number;
  readonly configurationId?: string;
  setup(tessar: PluginContext): void | Disposer | Promise<void | Disposer>;
}
type Disposer = () => void | Promise<void>;
```

Dev có thể viết class implements Plugin và dùng `new`. `version` bỏ qua được host xử lý như 1. Setup trả disposer hoặc đăng ký bằng defer.

### API trên tham số `tessar`

| API | Parameter | Trả về |
| --- | --- | --- |
| `.hook(name, handler, options?)` | `name: AnyEvent`; `handler(event, context)`; `{ kind?: EventKind; version?: number }` | `Disposer` |
| `.emit(name, payload)` | Tên event và payload đúng EventMap | `Promise<ResultOf<typeof name>>` |
| `.defer(disposer)` | `Disposer` | `void` |
| `.agent.register(agent)` | `Agent` | `void` |
| `.tools.register(tool)` | `Tool` | `void` |
| `.models.register(provider)` | `ModelProviderRegistration` | `void` |
| `.storage.register(backend)` | `StorageBackend` | `void` |
| `.state.define(definition)` | `PluginStateDefinition<T>` bỏ field `pluginId`; host tự gắn ID plugin | `PluginStateDefinition<T>` |
| `.effects.register(definition)` | `EffectDefinition` | `void` |
| `.interruptions.register(definition)` | `InterruptionDefinition` | `void` |
| `.registry.register(kind, id, value, version?)` | `string`, `string`, `unknown`, `number?` | `void` |

Custom events khai báo bằng module augmentation của `EventMap`. `HookSpec<P,R,C>` định nghĩa payload, result, context. Có các type public: `AnyEvent`, `PayloadOf<N>`, `ResultOf<N>`, `ContextOf<N>`, `EventHandler<N>`.

### Hook context

Context nền có `registry`, `sessionId?`, `signal?`, `session?`, `thread?`. Các identity khác xem EventContext; execution context bổ sung state và TrackedServices cho transformation/decision hooks.

`context.registry.get<T>(kind: string, id: string): T | undefined`.
`context.registry.list<T>(kind: string): readonly T[]`.

Session hook handle cung cấp identity `id`, method `scope()`, namespace `model`/`thread`, method `followUp()` với chữ ký như Session. Thread hook handle cung cấp `id` và các method `scope()`, `snapshot()`, `getHistory()`, `getCheckpoint()`, `listCheckpoints()`, `listInterrupts()` với chữ ký như Thread.

`EventKind`: notification, transformation, decision, barrier. Kind mặc định theo hook built-in; custom event không khai báo kind mặc định notification. Transformation trả payload thay thế; decision trả quyết định; notification không điều khiển flow; barrier được await và lỗi có thể chặn thao tác.

### EventEnvelope và helper quyết định

`new EventEnvelope(type, payload, context?)` với type string, payload generic và EventContext. Thuộc tính đọc gồm `type`, `payload` và identity/context. Dùng `event.type === text.delta` để narrow payload. Helper `.is()` đã được xóa khỏi public API.

| API | Parameter | Trả về |
| --- | --- | --- |
| `ToolDecision.allow()` | Không có | `OperationDecision` |
| `ToolDecision.deny(reason)` | `string` | `OperationDecision` |
| `TurnDecision.continue()` | Không có | `{ decision: "continue" }` |
| `TurnDecision.stop(reason)` | `string` | `{ decision: "stop"; reason: string }` |
| `InputDecision.continue(messages)` | `readonly MessageData[]` | `InputPreparation` |
| `InputDecision.handled(outcome)` | `{ output: readonly MessageData[] }` | `InputPreparation` |
| `InputDecision.reject(error)` | `ErrorInfo` | `InputPreparation` |

Tên map, tên string, kind, payload và result của **tất cả hook built-in** được liệt kê ở phụ lục event, không chỉ liệt kê tên.

## 13. State, effect, interruption và lời gọi phụ

### Definition API

| API | Parameter | Trả về |
| --- | --- | --- |
| `definePluginState(definition)` | `PluginStateDefinition<T>`: pluginId, namespace, schemaVersion, initial, migrate?, fork? | Definition |
| `defineEffect(definition)` | id, version, input/output InputDefinition, execute, reconcile? | Definition |
| `defineInterruption(definition)` | id, version, response InputDefinition, payload InputDefinition?, resolve(response,payload) | Definition |

`InputDefinition<T> = { readonly jsonSchema: JsonObject; parse(value: unknown): T }`. Các callback migrate/fork/resolve/reconcile và kiểu kết quả đầy đủ ở phụ lục. Đây là hợp đồng cho plugin, không yêu cầu app tự quản lý checkpoint class.

### TrackedServices trong tool và execution hook

| API | Parameter | Trả về |
| --- | --- | --- |
| `models.stream(request)` | `ModelRequest` | `AsyncIterable<ModelChunk>` |
| `effects.execute(definition, input, options)` | `EffectDefinition<I,O>`, `input: I`, `{ key: string }` | `Promise<O>` |
| `events.emit(name, payload)` | Tên notification event và payload | `Promise<void>` |

Không có protocol child reservation/admission trong core. Plugin tự kết hợp Agent và các primitive chung để quyết định dispatch, quan hệ và tổng hợp kết quả/usage. `StreamRecord.directUsage` chỉ tính các model attempt của chính execution đó, gồm auxiliary calls.

### State handle từ execution hook

Đối tượng `context.state` được runtime cấp, không new class nội bộ:

| Method | Parameter | Trả về |
| --- | --- | --- |
| `.get(definition)` | `PluginStateDefinition<T>` | `T` |
| `.update(definition, value)` | Definition và `T \| ((previous: T) => T)` | `void` |
| `.commit()` | Không có | `Promise<string>` checkpoint ID |
| `.withOwner(owner)` | `{ type: "thread" \| "stream" \| "turn" \| "agent" \| "session"; id: string }` | State handle theo owner |
| `.owned(owner)` | `{ type: "agent" \| "session"; id: string }` | Handle persistent CAS bên dưới |
| `.owned(owner).read(definition)` | Definition | `Promise<{ value: T; revision: number; schemaVersion: number }>` |
| `.owned(owner).update(definition, expectedRevision, value)` | Definition, `number`, `T` | `Promise<{ value: T; revision: number }>` |

`DecisionHookContext<D>.suspend(definition, payload): SuspendDecision` là cơ chế trả quyết định suspend trong decision hook. `definition` phải được đăng ký tương thích. Khác `ToolExecutionContext.suspend(payload)` trả ToolSuspension từ execute/resume của tool.

## 14. PluginManager và logger

### PluginManager

`new PluginManager({ directory: string; hostUrl?: string })`. `directory` bắt buộc, được resolve thành absolute path. `hostUrl` dùng để resolve SDK từ host; mặc định import.meta.url của module manager.

| API | Parameter | Trả về |
| --- | --- | --- |
| `.directory` | — | `string` absolute path |
| `.discover()` | Không có | `Promise<string[]>` |
| `.load(sources?)` | `readonly string[]`; bỏ qua thì discover | `Promise<Plugin[]>`; chưa attach vào Controller |
| `.install(source, options?)` | `source: string`, `{ name?: string }` | `Promise<string>` tên package đã cài/đăng ký |
| `.update(name?)` | `name?: string`; bỏ qua để cập nhật package đã cấu hình | `Promise<void>` |
| `.remove(name)` | `name: string` | `Promise<void>` |
| `.dispose()` | Không có | `void` |

Đường dẫn từ directory: `plugins/` chứa file/folder custom, `plugins.json` chứa `{ packages?: string[] }`, `npm/package.json` và `npm/node_modules/` cho package npm. Discover nhận `.mjs/.js/.cjs/.mts/.ts/.cts`, bỏ file declaration; folder chọn `index` tương ứng. Module plugin default-export một instance có id/setup. Git/URL/tarball source có thể cần `options.name`.

### LoggerPlugin

`new LoggerPlugin(options?: LoggerOptions)` với `{ level?: LogLevel; transports?: readonly LogTransport[] }`.
`.id = "logger"`, `.setup(tessar: PluginContext): void`.

Mặc định level `info`, dùng ConsoleTransport ghi JSON qua stderr. LogLevel gồm `debug`, `info`, `warn`, `error`. `LoggerOptions` không có callback `write`; destination implement `LogTransport.write(entry)` và optional `close()`. `new FileTransport({ path, groupBy? })` ghi JSON Lines, `path` là filename; `logGroup.none` mặc định dùng một file, `thread`/`session`/`stream` nhóm theo identity, thiếu identity thì fallback về path. LogEntry dùng timestamp của event. Default export ở subpath là instance đã tạo; named class dùng với new.

### OpenTelemetryPlugin

`new OpenTelemetryPlugin(options: OpenTelemetryOptions)`; `.id = "opentelemetry"`, `.setup(tessar): Promise<void>`. `adapters` bắt buộc là mảng không rỗng các TraceAdapter; `realtime?: boolean` mặc định false, `serviceName?`, `traceName?`, `tags?: readonly string[]`. Mỗi adapter có `createExporter(): SpanExporter`; OTLPAdapter còn có protected `mapSpan` cho lớp kế thừa.

Adapter constructors nhận optional options: OTLP `{ endpoint?, headers? }`; Langfuse `{ publicKey?, secretKey?, baseUrl?, prompt?: { name, version } }`; Laminar `{ apiKey?, endpoint? }`. Laminar dùng `LMNR_PROJECT_API_KEY`, optional `LMNR_BASE_URL`; endpoint explicit là URL đầy đủ `/v1/traces`. Credentials có thể lấy từ environment; xem [guide](../examples/guide/opentelemetry.md).

Mỗi invocation/followUp có trace mới với Agent root. Langfuse Session nhóm theo Thread ID; Tessar Session ID giữ trong metadata. Resume/recover tạo segment mới, không tái sử dụng span đã đóng. `realtime: true` gửi mỗi span đã hoàn thành qua native SimpleSpanProcessor; không gửi token hoặc span đang chạy. Mặc định native batching; disposal flush các export đang chờ.

## 15. Storage

### Constructor plugin và factory backend

| API | Parameter | Trả về |
| --- | --- | --- |
| `new SqliteStoragePlugin(options)` | `{ filename: string }` | Plugin, id `storage.sqlite` |
| `createSqliteBackend(options)` | `{ filename: string }` | `Promise<StorageBackend>` |
| `new PostgresqlStoragePlugin(options)` | `{ connectionString: string; schema?: string; driverOptions?: Omit<PoolConfig, "connectionString"> }` | Plugin, id `storage.postgresql` |
| `createPostgresqlBackend(options)` | Cùng options PostgreSQL | `Promise<StorageBackend>` |
| `new MongoDBStoragePlugin(options)` | `{ uri: string; databaseName: string; clientOptions?: MongoClientOptions }` | Plugin, id `storage.mongodb` |
| `createMongoDBBackend(options)` | Cùng options MongoDB | `Promise<StorageBackend>` |
| `createMemoryBackend(options?)` | `{ clock?: Clock }` | `StorageBackend`, đồng bộ |

Mỗi plugin có `.setup(tessar: PluginContext): Promise<void>`. PostgreSQL schema mặc định `tessar`; tên schema phải hợp lệ. SQLite dùng Node SQLite. MongoDB cần transaction support. Không truyền thêm `tables` hay migration option qua constructor này. `PoolConfig` và `MongoClientOptions` thuộc driver, không phải một tập field Tessar định nghĩa lại.

### API cho tác giả backend

`StorageBackend` là contract public để `tessar.storage.register(backend)`. Các namespace `records`, `sessions`, `ownedState`, `threads`, `executions`, `checkpoints`, `commits`, `ownership` và `close()` được chép đầy đủ ở phụ lục storage, gồm tất cả tham số và return type.

### Record độc lập — dùng trực tiếp hoặc từ plugin

`backend.records` và `tessar.storage.records` dùng chung contract bên dưới. Backend
dùng độc lập không cần runtime; plugin truy cập sau Controller initialize.

```ts
interface StoredRecord {
  readonly id: string;
  readonly namespace: string;
  readonly scope: Scope;
  readonly data: JsonValue;
  readonly createdAt: string;
}
interface AppendRecordOptions {
  id?: string;
  namespace: string;
  scope?: Scope;
  data: JsonValue;
}
interface RecordsQuery extends StateQuery, PageOptions { namespace: string; }
interface RecordStore {
  append(options: AppendRecordOptions): Promise<StoredRecord>;
  get(namespace: string, id: string, query?: StateQuery): Promise<StoredRecord | null>;
  list(query: RecordsQuery): Promise<Page<StoredRecord>>;
}
```

ID mặc định UUID, createdAt ISO tự sinh. Cặp namespace/ID trùng báo
`RegistrationConflict`, không ghi đè. Scope filter theo subset như API state hiện
tại; bỏ scope nghĩa là không lọc theo user. List bắt buộc namespace, limit mặc
định 50, tối đa 200; thứ tự tăng dần createdAt rồi ID, cursor gắn namespace/scope.
Không tự lưu mọi model call, không đưa data vào messages/checkpoint và không bị
xóa theo Thread. Xem [storage guide](../examples/guide/storage.md#store-independent-json-records).

Backend tự implement contract; ứng dụng thông thường dùng Session/Thread thay vì gọi trực tiếp các port. Cơ chế lưu records/checkpoint có thể được inspect qua các data type public trong phụ lục; không expose constructor coordinator/runtime nội bộ.

### TypeSafe client độc lập — `@tessar/typesafe`

`new TypeSafe({ apiKey?, baseURL?, model?, timeout?, maxRetries?, records?, headers? })`.
Key lấy từ config hoặc `TYPESAFE_API_KEY`; baseURL từ config, `TYPESAFE_BASE_URL`,
hoặc `https://api.typesafe.ai`. Timeout mặc định 30000 ms mỗi attempt; maxRetries
mặc định 3 lần retry. records nhận `RecordStore`, client không đóng backend.

`typesafe.generate({ state, questions, model?, assets? }, { id?, scope?, metadata?, signal? }?)`.
State và questions bắt buộc mỗi lần gọi; constructor không nhận state/questions.
State là string, JSON object hoặc array. Model phải có ở constructor hoặc request.
`id` tự sinh UUID nếu không truyền; scope và metadata chỉ lưu cục bộ, không gửi
provider. Client không có initialize/dispose hay alias systemOne/evaluate.

Trả `Promise<TypeSafeResponse<Q>>`: `{ model, answers, usage }` theo native API,
infer key/type của từng answer và các choice label. Hỗ trợ noul, choice, score,
box và inline image assets với provider header rõ ràng. Không có multipart helper.
HTTP errors là `TypeSafeAPIError(status, body, requestId)`; success sai cấu trúc là
`TypeSafeResponseError(message, body)`. Các class lỗi có các field readonly tương ứng.

Khi có records, lưu một record mỗi generate trong `typesafe.calls`, gồm request,
response/error, status, startedAt/endedAt, attemptCount và metadata. Lỗi lưu không
retry provider; lỗi provider + lỗi lưu giữ cả hai trong AggregateError. Không có
automatic Agent integration hoặc Logger/OTel export. Xem [API đầy đủ và ví dụ](../packages/typesafe/README.md).

## 16. Model profile và provider tự viết

`ModelRef = { providerId: string; modelId: string; connectionId?: string }`.
`Model` có descriptor `.ref`, method `.profile()` và `.refreshProfile({ signal? }?)`. Field `profile` trong kết quả `session.model.list()` vẫn là dữ liệu snapshot, không phải method.

`ModelProfile` gồm identity, name, contextWindow, maxInputTokens, maxOutputTokens, capabilities, pricing, metadata. Thiếu thông tin thể hiện null/unavailable theo type, không tự điền số liệu phỏng đoán.

Provider plugin đăng ký `ModelProviderRegistration`:

| Field | Kiểu |
| --- | --- |
| `id` | `string` |
| `create` | `(modelId: string) => ModelAdapter` |
| `metadata?` | `MetadataResolver` với `.resolve(ref, { signal? }): Promise<ProfilePatch>` |
| `endpoint?`, `metadataPartition?` | `string` |
| `catalogModelRef?` | `(ref: ModelRef) => ModelRef \| null` |
| `catalogMappingVersion?` | `number`; bắt buộc số nguyên dương khi khai báo mapping |

`ModelAdapter` có ref, connection?, options?, withModel?, validate(request), stream(request, context). Toàn bộ request/response/chunk contract trong phụ lục.

`new ProfileResolver(options?: { catalog?: CatalogSnapshot; clock?: Clock })` cung cấp:

| Method | Parameter | Trả về |
| --- | --- | --- |
| `.needsRefresh(ref, provider)` | ModelRef, ModelProviderRegistration | `boolean` |
| `.current(ref, provider)` | Tương tự | `ModelProfile` |
| `.resolve(ref, provider, signal?)` | Tương tự, AbortSignal? | `Promise<ModelProfile>` |
| `.clear()` | Không có | `void` |

CatalogSnapshot là hình dạng `{ revision: string; fetchedAt: string; source?: string; entries: Record<string, Record<string, ProfilePatch>> }`; type này hiện không export trực tiếp từ root, nhưng xuất hiện trong constructor ProfileResolver. Phụ lục ghi đúng cấu trúc declaration.

## 17. Hàm nền tảng được export

Đây là các hàm root hiện cho phép import, hữu ích cho tác giả plugin/provider/backend. Chữ ký đầy đủ nằm ở phụ lục tương ứng.

| Nhóm | API và parameter |
| --- | --- |
| JSON | `assertJson(value: unknown, parents?: Set<object>)`, `deepFreeze<T>(value: T)`, `immutable<T>(value: T)`, `snapshotModelOptions(value: object)` |
| ID / clock | `randomIds.next(kind: string): string`, `systemClock.now(): string`; type `Clock`, `IdGenerator` |
| Error | `new TessarError(code, message, options?)`, `.isInstance(value)` kế thừa theo class, `.toJSON()`, `fail(code, message)`, `requireId(id, name?)`, `errorInfo(error, origin?)`, `errorFromInfo(info)` |
| Usage | `normalizeUsage(input: Partial<TokenCounts>, providerDetails?: JsonValue)`, `aggregateUsage(attempts: readonly { id: string; usage: ModelUsage }[])`, constant `tokenMetrics` |
| Scope | `normalizeScope(value?: Scope)`, `matchesScope(state: Scope, filter?: Scope)` |
| Storage validation | `buildThreadInfo(batch, head, stream)`, `canonicalJson(value: unknown)`, `commitFingerprint(batch: CommitBatch)`, `validateBatch(batch: CommitBatch)`, `validateSession(value, previous, expected, thread)` |
| Paging | `checkpointSafety(cp)`, `limitOf(limit?)`, `encodeCursor(value)`, `decodeCursor(value)`, `compareOrdinal(a,b)`, `pageAfter(options,binding)`, `pageRows(rows,options?,binding?)`, `recordBinding(kind,threadId,query)`, `historyCursor(id,options,query)` |

Scope hiện là `Readonly<Record<string, string | number | boolean>>`. Number phải hữu hạn; không nhận nested object/array/null. Bỏ scope tương đương `{}`; filter chỉ yêu cầu các key đã khai báo khớp.

## 18. Testing SDK

Các API này ở subpath testing public; không phải API điều khiển runtime sản phẩm.

### ScriptedProvider

`new ScriptedProvider(scripts: readonly ModelScript[])`.
`ModelScript = { text?: string; response?: ModelResponse; usage?: Partial<TokenCounts>; chunks?: readonly ModelChunk[]; error?: Error; gate?: Promise<void> }`.

Thuộc tính `.ref: ModelRef`, `.calls: ModelRequest[]`. Methods `.withModel(modelId: string): ModelAdapter`, `.validate(request: ModelRequest): void`, `.stream(request: ModelRequest, context: ModelCallContext): AsyncIterable<ModelChunk>`.

### AgentHarness

| API | Parameter | Trả về |
| --- | --- | --- |
| `AgentHarness.create(options?)` | `{ modelScripts?: readonly ModelScript[]; plugins?: readonly Plugin[]; backend?: StorageBackend; instructions?: string; limits?: Partial<StreamLimits>; tools?: AgentTools }` | `Promise<AgentHarness>` |
| `.agent`, `.controller`, `.provider`, `.backend` | — | Đối tượng được tạo cho test |
| `.createThread(options?)` | `CreateThreadOptions`: title?, scope?, instructions?, messages?, metadata? | `Promise<ThreadInfo>`; đây là fixture helper, không phải Session.thread.create |
| `.admit(request, target?)` | Test request và test delivery target ở dưới | `Stream` |
| `.collect(stream)` | `Stream` | `Promise<StreamEvent[]>`; throw nếu gặp stream.error |
| `.records(streamId)` | `string` | `Promise<{ stream: StreamRecord; turns: TurnRecord[]; attempts: ModelAttemptRecord[]; tools: ToolExecutionRecord[]; messages: readonly MessageData[] }>` |
| `.checkpoint(threadId)` | `string` | `Promise<Checkpoint>` |
| `.dispose()` | Không có | `Promise<void>` |

Test request có một trong ba dạng: input `{ kind: "input", id?, threadId, input: readonly MessageData[], model: ModelRef, context?, limits? }`; resume `{ kind: "resume", threadId, interruptId, value: JsonValue, model?: ModelRef }`; recover `{ kind: "recover", threadId, streamId, model?: ModelRef }`. Field chung optional: signal, adapter, modelOptions, session hook handle, thread hook handle. Đây là parameter cho test harness, không export thêm execution engine vào root SDK.

Test target optional là `{ kind: "iterator" }` hoặc `{ kind: "observer"; observe(event: StreamEvent): void; admitted?(receipt: ExecutionReceipt): void; rejected?(error: ErrorInfo): void; closed?(): void }`.

### Storage conformance

`initialBatch(threadId?: string): CommitBatch` — mặc định `"t1"`.
`storageConformance(name: string, factory: () => Promise<StorageBackend>): void` — đăng ký Vitest suite; cần Vitest trong môi trường test.

## 19. Điểm cần nghiệm thu

Các dòng này ghi nhận contract hiện tại sau đợt sửa tính nhất quán ngày 2026-10-25:

- **Alias tool:** object key quyết định tên đăng ký, không mutate Tool gốc. Agent và plugin đều giữ schema identity khi resume.
- **Concurrency:** field `tools.concurrency` hiện vẫn có; bỏ khai báo thì Infinity.
- **Session input:** followUp nhận string, Message hoặc mảng Message; chưa có options per followUp. count()/isEmpty() đọc hàng đợi.
- **Provider plugin:** OpenAIPlugin và OpenAIProvider dùng chung protocol/native options. Session giữ executable named connection trong runtime; restart phải đăng ký lại binding có cùng ID và descriptor.
- **Event:** mỗi envelope có timestamp phát event; lifecycle Stream/Turn/model/tool có record startedAt/endedAt. stream.error tới cả hooks và consumer, phân biệt target execution/consumer. Kiểm tra loại event qua `.type`. Các group map là lowercase/camelCase và giá trị event là string.
- **Instructions:** Session.thread.create không nhận instructions; type CreateThreadOptions dùng trong hook/testing vẫn có field này.
- **Suspend:** Agent.resume trả Stream; Session.resume/recover trả receipt và phát event qua subscription.
- **Signal:** Agent.sendSignal nhận input theo streamId hoặc threadId; khác hàng đợi followUp. Metadata cấp content part đã có; core không định nghĩa visibility hoặc policy của metadata.
- **Đã thu hẹp declaration:** service backend/registry/clock/ID generator/cancel nội bộ của Agent; diagnostics/report của Controller; cache/catalog của ProfileResolver và registry/queries của harness không xuất hiện trong API public sau build. Session/Thread có constructor private; các factory nội bộ không export ra declaration. OpenAIProvider chỉ công khai constructor một object configuration, không expose tham số shared connection nội bộ.
- **Thay đổi cách đọc:** `agent.limits()`, `session.scope()`, `session.metadata()`, `thread.scope()`, `model.profile()` là method. Không có alias property trả cùng dữ liệu. Các field metadata/scope/profile trong DTO vẫn là dữ liệu và được giữ nguyên schema.

## 20. Chữ ký và kiểu dữ liệu đầy đủ

Các phần dưới đối chiếu trực tiếp declaration hiện tại để xem đủ parameter con, optional field, callback và kết quả. Những type là dữ liệu checkpoint/trace có thể mô tả trạng thái execution; chúng là kiểu public được API đọc trả về, không phải lời mời gọi runtime engine.

<!-- DECLARATION_REFERENCE -->

## Chữ ký public của các class

Các block này giữ nguyên tham số từ declaration đã build, bỏ field private/protected. Session và Thread được tạo qua Controller/Session; không có constructor public. OpenAIProvider được làm phẳng hai member kế thừa công khai `ref` và `connection`. `AgentHarness.collect()` dùng alias `StreamEvent[]` thay cho union event đã mở rộng. `OptionsFor<A>` là type hỗ trợ nội bộ, tương ứng Responses hoặc Chat options theo `A`, không phải root export.

### Agent

```ts
export declare class Agent<M extends ModelSelection = ModelSelection> {
    readonly id: string;
    constructor(options: AgentOptions<M>);
    listTool(): readonly Tool[];
    getModel(): M;
    getInstruction(): Instruction;
    limits(): StreamLimits;
    stream<T extends ModelAdapter = M extends ModelAdapter ? M : ModelAdapter>(input: AgentInput, options?: AgentStreamOptions<T>): Stream;
    generate<T extends ModelAdapter = M extends ModelAdapter ? M : ModelAdapter>(input: AgentInput, options?: AgentExecutionOptions<T>): Promise<GenerateOutcome>;
    resume(options: AgentResumeOptions): Stream;
    sendSignal(options: SendSignalOptions): Promise<void>;
    shutdown(): Promise<void>;
}
```

### Controller

```ts
export declare class Controller {
    readonly id: string;
    readonly agent: Agent;
    readonly plugins: {
        attach: (plugin: Plugin) => Promise<void>;
        detach: (id: string) => Promise<void>;
    };
    constructor(options: {
        id: string;
        agent: Agent;
        plugins?: readonly Plugin[];
    });
    initialize(): Promise<void>;
    createSession(options?: SessionOptions): Promise<Session>;
    getSession(id: string, query?: StateQuery): Promise<Session | null>;
    isReady(): boolean;
    listSessions(query?: StateQuery & PageOptions): Promise<import("./state/schema.js").Page<SessionRecord>>;
    dispose(): Promise<void>;
}
```

### Session

```ts
export declare class Session {
    readonly controller: Controller;
    readonly state: Readonly<{
        get: () => RuntimeState;
    }>;
    isIdle(): boolean;
    isDisposed(): boolean;
    readonly agent: import("./agent.js").Agent<import("./agent.js").ModelSelection>;
    readonly id: string;
    metadata(): JsonObject;
    scope(): Scope;
    readonly model: Readonly<{
        get: () => string;
        name: () => string;
        info: () => SessionModelInfo & {
            readonly options?: JsonObject;
        };
        list: () => readonly SessionModelInfo[];
        switch: (modelId: string, options?: JsonObject) => Promise<void>;
        setEffort: (level: string) => Promise<void>;
    }>;
    subscribe(observer: Observer): () => void;
    subscribe<N extends AnyEvent>(name: N, observer: (event: EventEnvelope<PayloadOf<N>, N>) => unknown): () => void;
    readonly thread: {
        create: (options?: SessionThreadOptions) => Promise<Thread>;
        switch: (id: string) => Promise<Thread>;
        get: (id: string) => Promise<Thread | null>;
        getId: () => string | null;
        list: (options?: PageOptions) => Promise<import("./state/schema.js").Page<import("./state/schema.js").ThreadInfo>>;
        rename: (title: string, target?: ThreadTarget) => Promise<void>;
        fork: (options?: ForkOptions & ThreadTarget) => Promise<Thread>;
        delete: (target?: ThreadTarget) => Promise<void>;
        purge: (target?: ThreadTarget) => Promise<void>;
        getHistory: (options?: HistoryOptions & ThreadTarget) => Promise<import("./state/queries.js").HistoryPage>;
    };
    readonly followUp: ((input: string | MessageData | readonly MessageData[]) => Promise<QueuedInputReceipt>) & {
        count: () => number;
        isEmpty: () => boolean;
    };
    resume(options: {
        interruptId: string;
        value: JsonValue;
        model?: Model | ModelRef;
    }): Promise<ExecutionReceipt>;
    recover(options: {
        streamId: string;
        model?: Model | ModelRef;
    }): Promise<ExecutionReceipt>;
    abort(reason?: string): Promise<void>;
    dispose(): Promise<void>;
}
```

### Thread

```ts
export declare class Thread {
    readonly id: string;
    scope(): Scope;
    snapshot(): Promise<{
        id: string;
        threadId: string;
        parentCheckpointId: string | null;
        revision: number;
        schemaVersion: 1;
        createdAt: string;
        state: import("./state/schema.js").ThreadState;
        execution: import("./state/schema.js").ExecutionPosition | null;
        cause: import("./state/schema.js").CheckpointCause;
        activeStreamId: string | null;
        currentCheckpointId: string;
        usage: import("./trace/usage.js").UsageSummary;
    }>;
    getHistory(options?: HistoryOptions): Promise<import("./state/queries.js").HistoryPage>;
    getCheckpoint(id: string): Promise<import("./state/schema.js").Checkpoint | null>;
    listCheckpoints(options?: PageOptions): Promise<import("./state/schema.js").Page<import("./state/schema.js").CheckpointInfo>>;
    getStream(id: string): Promise<import("./index.js").StreamRecord | null>;
    listStreams(options?: PageOptions): Promise<import("./state/schema.js").Page<import("./index.js").StreamRecord>>;
    listTurns(streamId: string, options?: PageOptions): Promise<import("./state/schema.js").Page<import("./index.js").TurnRecord>>;
    listModelAttempts(turnId: string, options?: PageOptions): Promise<import("./state/schema.js").Page<import("./index.js").ModelAttemptRecord>>;
    listToolExecutions(turnId: string, options?: PageOptions): Promise<import("./state/schema.js").Page<import("./index.js").ToolExecutionRecord>>;
    getInterrupt(id: string): Promise<import("./state/schema.js").InterruptRecord | null>;
    listInterrupts(options?: PageOptions & {
        status?: "pending" | "resolved" | "cancelled";
    }): Promise<import("./state/schema.js").Page<import("./state/schema.js").InterruptRecord>>;
    dispose(): Promise<void>;
}
```

### Message

```ts
export declare abstract class Message implements MessageData {
    readonly role: MessageRole;
    readonly schemaVersion: 1;
    readonly id: string;
    readonly content: readonly ContentPart[];
    readonly metadata?: JsonObject;
    readonly providerState?: JsonValue;
    readonly toolCallId?: string;
}
```

### HumanMessage

```ts
export declare class HumanMessage extends Message {
    constructor(content: string | readonly ContentPart[], options?: MessageOptions);
}
```

### SystemMessage

```ts
export declare class SystemMessage extends Message {
    constructor(content: string | readonly ContentPart[], options?: MessageOptions);
}
```

### AssistantMessage

```ts
export declare class AssistantMessage extends Message {
    constructor(content: string | readonly ContentPart[], options?: MessageOptions);
}
```

### ToolMessage

```ts
export declare class ToolMessage extends Message {
    constructor(content: string | readonly ContentPart[], options?: MessageOptions & {
        toolCallId?: string;
    });
}
```

### Tool

```ts
export declare class Tool<I = any, R = any, O extends ToolReturn = ToolReturn> {
    readonly name: string;
    readonly description: string;
    readonly schema: z.ZodType<I>;
    readonly jsonSchema: JsonObject;
    readonly execute: (input: I, context: ToolExecutionContext) => Promise<Normalized<Awaited<O>>>;
    readonly resumeSchema?: z.ZodType<R>;
    readonly resumeJsonSchema: JsonObject;
    readonly resume?: (response: R, input: I, context: ToolExecutionContext) => ToolResult | Promise<ToolResult>;
    readonly configurationId: string;
    readonly recovery?: ToolRecovery<I>;
    constructor(definition: ToolDefinition<I, R, O>);
}
```

### ToolSuspension

```ts
export declare class ToolSuspension {
    readonly payload: JsonValue;
    constructor(payload: JsonValue);
}
```

### EventEnvelope

```ts
export declare class EventEnvelope<P = any, N extends string = string> implements EventContext {
    readonly type: N;
    readonly payload: P;
    readonly controllerId?: string;
    readonly agentId?: string;
    readonly sessionId?: string;
    readonly scope?: JsonObject;
    readonly threadId?: string;
    readonly streamId?: string | null;
    readonly handleId?: string;
    readonly sequence?: number;
    readonly timestamp: string;
    readonly checkpointRevision?: number;
    constructor(type: N, payload: P, context?: EventContext);
}
```

### ProfileResolver

```ts
export declare class ProfileResolver {
    constructor(options?: {
        catalog?: CatalogSnapshot;
        clock?: Clock;
    });
    needsRefresh(ref: ModelRef, provider: ModelProviderRegistration): boolean;
    current(ref: ModelRef, provider: ModelProviderRegistration): ModelProfile;
    resolve(ref: ModelRef, provider: ModelProviderRegistration, signal?: AbortSignal): Promise<ModelProfile>;
    clear(): void;
}
```

### OpenAIProvider

```ts
export declare class OpenAIProvider<A extends OpenAIAPI = "responses"> extends OpenAIAdapter {
    readonly options: Readonly<OptionsFor<A>>;
    readonly api: A;
    constructor(configuration: OpenAIProviderOptions<A> & {
        api?: A;
    });
    withModel(modelId: string): OpenAIProvider<A>;
    effortOptions(level: string, options: JsonObject): JsonObject;
    validate(request: ModelRequest): void;
    stream(request: ModelRequest, context: ModelCallContext): AsyncIterable<ModelChunk>;
    profile(): Readonly<ModelProfile>;
    refreshProfile(options?: {
        signal?: AbortSignal;
    }): Promise<ModelProfile>;
}
```

### OpenAIPlugin

```ts
export type OpenAIPluginOptions = Omit<OpenAIProviderOptions<"responses">, "model"> | Omit<OpenAIProviderOptions<"chat-completions">, "model">;

export declare class OpenAIPlugin implements Plugin {
    readonly id: string;
    constructor(options: OpenAIPluginOptions);
    setup(tessar: PluginContext): void;
}
```

### PluginManager

```ts
export declare class PluginManager {
    readonly directory: string;
    constructor(options: PluginManagerOptions);
    discover(): Promise<string[]>;
    load(sources?: readonly string[]): Promise<Plugin[]>;
    install(source: string, options?: {
        name?: string;
    }): Promise<string>;
    update(name?: string): Promise<void>;
    remove(name: string): Promise<void>;
    dispose(): void;
}
```

### LoggerPlugin

```ts
export declare class LoggerPlugin implements Plugin {
    readonly id = "logger";
    constructor(options?: LoggerOptions);
    setup(tessar: PluginContext): void;
}
```

### SqliteStoragePlugin

```ts
export declare class SqliteStoragePlugin implements Plugin {
    readonly id = "storage.sqlite";
    constructor(options: SqliteStorageOptions);
    setup(tessar: PluginContext): Promise<void>;
}
```

### PostgresqlStoragePlugin

```ts
export declare class PostgresqlStoragePlugin implements Plugin {
    readonly id = "storage.postgresql";
    constructor(options: PostgresqlStorageOptions);
    setup(tessar: PluginContext): Promise<void>;
}
```

### MongoDBStoragePlugin

```ts
export declare class MongoDBStoragePlugin implements Plugin {
    readonly id = "storage.mongodb";
    constructor(options: MongoDBStorageOptions);
    setup(tessar: PluginContext): Promise<void>;
}
```

### Testing

```ts
export declare class ScriptedProvider implements ModelAdapter {
    readonly ref: ModelRef;
    readonly calls: ModelRequest[];
    constructor(scripts: readonly ModelScript[]);
    withModel(modelId: string): ModelAdapter;
    validate(request: ModelRequest): void;
    stream(request: ModelRequest, context: ModelCallContext): AsyncIterable<ModelChunk>;
}
```

### AgentHarness

```ts
export declare class AgentHarness {
    readonly agent: Agent;
    readonly controller: Controller;
    readonly provider: ScriptedProvider;
    readonly backend: StorageBackend;
    static create(options?: {
        modelScripts?: readonly ModelScript[];
        plugins?: readonly Plugin[];
        backend?: StorageBackend;
        instructions?: string;
        limits?: Partial<StreamLimits>;
        tools?: AgentTools;
    }): Promise<AgentHarness>;
    admit(request: ExecutionRequest, target?: DeliveryTarget): Stream;
    createThread(options?: CreateThreadOptions): Promise<import("../state/schema.js").ThreadInfo>;
    collect(stream: Stream): Promise<StreamEvent[]>;
    records(streamId: string): Promise<{
        stream: import("../index.js").StreamRecord;
        turns: import("../index.js").TurnRecord[];
        attempts: import("../index.js").ModelAttemptRecord[];
        tools: import("../index.js").ToolExecutionRecord[];
        messages: readonly import("../index.js").MessageData[];
    }>;
    checkpoint(threadId: string): Promise<import("../state/schema.js").Checkpoint>;
    dispose(): Promise<void>;
}
```

## Các type và hàm public

### Signal options

Nguồn: [packages/core/src/signal.ts](packages/core/src/signal.ts).

```ts
export type SignalTarget = {
    streamId: string;
    threadId?: never;
} | {
    threadId: string;
    streamId?: never;
};

export type SendSignalOptions = SignalTarget & {
    content: string | readonly ContentPart[];
    persist?: boolean;
    tagName?: string;
    attributes?: Record<string, string | number | boolean>;
    metadata?: JsonObject;
};
```

### Kiểu tham số và kết quả Agent

Nguồn: [packages/core/src/agent.ts](packages/core/src/agent.ts).

```ts
export type ModelSelection = ModelAdapter | Model | ModelRef;

export type AgentInput = string | MessageData | readonly MessageData[];

export interface AgentOptions<M extends ModelSelection = ModelSelection> {
    id: string;
    model: M;
    instructions?: string | Instruction;
    limits?: Partial<StreamLimits>;
    tools?: AgentTools;
}

export interface AgentTools {
    concurrency?: number;
    readonly [alias: string]: Tool | number | undefined;
}

export interface AgentExecutionOptions<M = ModelAdapter> {
    model?: M | Model | ModelRef | string;
    modelOptions?: ModelOptions<M>;
    scope?: Scope;
    context?: JsonObject;
    signal?: AbortSignal;
    limits?: Partial<StreamLimits>;
}

export interface AgentStreamOptions<M = ModelAdapter> extends AgentExecutionOptions<M> {
    id?: string;
}

export interface GenerateOutcome {
    threadId: string;
    streamId: string;
    status: StreamRecord["status"];
    output: readonly MessageData[];
    usage: import("./trace/usage.js").UsageSummary;
    interrupt: InterruptRecord | null;
    error: ErrorInfo | null;
}

export interface AgentResumeOptions {
    threadId: string;
    interruptId: string;
    value: JsonValue;
    scope?: Scope;
    signal?: AbortSignal;
}
```

### Session và paging

Nguồn: [packages/core/src/session.ts](packages/core/src/session.ts).

```ts
export interface SessionOptions {
    id?: string;
    scope?: Scope;
    model?: Model | ModelRef;
    metadata?: JsonObject;
    threadId?: string;
}

export type SessionThreadOptions = Pick<CreateThreadOptions, "id" | "title" | "messages" | "metadata">;

export interface SessionModelInfo {
    readonly id: string;
    readonly name: string;
    readonly profile: Readonly<ModelProfile>;
}

export interface ThreadTarget {
    threadId?: string;
}
```

### Stream và delivery target cho harness

Nguồn: [packages/core/src/engine/delivery.ts](packages/core/src/engine/delivery.ts).

```ts
export interface Stream extends AsyncIterable<StreamEvent> {
    readonly id: string | null;
    readonly threadId: string;
    readonly handleId: string;
    abort(reason?: string): void;
}

export type DeliveryTarget = {
    kind: "iterator";
} | {
    kind: "observer";
    observe: (event: StreamEvent) => void;
    admitted?: (receipt: {
        streamId: string;
        threadId: string;
    }) => void;
    rejected?: (error: ErrorInfo) => void;
    closed?: () => void;
};
```

### Execution request cho harness

Nguồn: [packages/core/src/engine/frame.ts](packages/core/src/engine/frame.ts).

```ts
export type ExecutionRequest = ({
    kind: "input";
    id?: string;
    threadId: string;
    input: readonly MessageData[];
    model: ModelRef;
    context?: JsonObject;
    limits?: Partial<StreamLimits>;
    initialSignal?: {
        persist: boolean;
    };
} | {
    kind: "resume";
    threadId: string;
    interruptId: string;
    value: JsonValue;
    model?: ModelRef;
} | {
    kind: "recover";
    threadId: string;
    streamId: string;
    model?: ModelRef;
}) & {
    signal?: AbortSignal;
    adapter?: ModelAdapter;
    modelOptions?: JsonObject;
    session?: SessionHookHandle;
    thread?: ThreadHookHandle;
};
```

`DeliveryTarget` và `ExecutionRequest` mô tả tham số testing của AgentHarness; không phải tên import từ root `@tessar/core`.

### Message và content parts

Nguồn: [packages/core/src/messages/parts.ts](packages/core/src/messages/parts.ts).

```ts
export type ContentPart = ({
    readonly type: "text";
    readonly text: string;
} | {
    readonly type: "reasoning";
    readonly text: string;
    readonly providerState?: JsonValue;
} | {
    readonly type: "tool-call";
    readonly toolCallId: string;
    readonly name: string;
    readonly arguments: JsonObject;
} | {
    readonly type: "image" | "audio" | "file";
    readonly mediaType: string;
    readonly data: string;
} | {
    readonly type: "data";
    readonly data: JsonValue;
}) & {
    readonly metadata?: JsonObject;
};
```

### Hình dạng Message

Nguồn: [packages/core/src/messages/message.ts](packages/core/src/messages/message.ts).

```ts
export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface MessageOptions {
    id?: string;
    metadata?: JsonObject;
    providerState?: JsonValue;
}

export interface MessageData {
    readonly schemaVersion: 1;
    readonly id: string;
    readonly role: MessageRole;
    readonly content: readonly ContentPart[];
    readonly metadata?: JsonObject;
    readonly providerState?: JsonValue;
    readonly toolCallId?: string;
}

export declare function normalizeContent(content: string | readonly ContentPart[]): readonly ContentPart[];
```

### MessageCodec

Nguồn: [packages/core/src/messages/codec.ts](packages/core/src/messages/codec.ts).

```ts
export declare const MessageCodec: {
    encode(message: Message): MessageData;
    decode(data: unknown): Message;
};
```

### Instruction

Nguồn: [packages/core/src/instructions/instruction.ts](packages/core/src/instructions/instruction.ts).

```ts
export interface InstructionSection {
    readonly id: string;
    readonly content: string;
    readonly order?: number;
}

export interface Instruction {
    readonly sections: readonly InstructionSection[];
}

export declare function buildInstruction(sections: readonly InstructionSection[]): Instruction;

export declare function normalizeInstruction(value?: string | Instruction): Instruction;
```

### Tool definition, recovery và context

Nguồn: [packages/core/src/tools/tool.ts](packages/core/src/tools/tool.ts).

```ts
export type ToolOutput = JsonValue | ToolMessage;

export type ToolResult = ToolOutput | ToolSuspension;

type ToolReturn = ToolResult | Promise<ToolResult>;

type Normalized<T> = T extends ToolSuspension ? ToolSuspension : ToolMessage;

export interface ToolExecutionContext extends TrackedServices {
    readonly signal: AbortSignal;
    readonly threadId: string;
    readonly streamId: string;
    readonly turnId: string;
    readonly toolExecutionId: string;
    emit(progress: JsonValue): void;
    suspend(payload: JsonValue): ToolSuspension;
}

export type ReconcileResult = {
    status: "completed";
    result: ToolOutput;
} | {
    status: "safeToRetry";
} | {
    status: "unknown";
};

export interface ToolRecovery<I> {
    idempotencyKey(input: I, identity: {
        toolExecutionId: string;
    }): string;
    reconcile(operation: {
        id: string;
        input: I;
        key: string;
    }): Promise<ReconcileResult>;
}

export interface ToolDefinition<I, R = JsonValue, O extends ToolReturn = ToolReturn> {
    name: string;
    description: string;
    schema: z.ZodType<I>;
    execute(input: I, context: ToolExecutionContext): O;
    resumeSchema?: z.ZodType<R>;
    resume?(response: R, input: I, context: ToolExecutionContext): ToolResult | Promise<ToolResult>;
    recovery?: ToolRecovery<I>;
}

export declare function createTool<I, R = JsonValue, O extends ToolReturn = ToolReturn>(definition: ToolDefinition<I, R, O>): Tool<I, R, O>;
```

`ToolReturn` và `Normalized<T>` trong block trên chỉ là ký hiệu type hỗ trợ chữ ký Tool; không phải tên export từ root.

### InputDefinition

Nguồn: [packages/core/src/tools/input-definition.ts](packages/core/src/tools/input-definition.ts).

```ts
export interface InputDefinition<T> {
    readonly jsonSchema: JsonObject;
    parse(value: unknown): T;
}
```

### Event và plugin contracts

Nguồn: [packages/core/src/events/definition.ts](packages/core/src/events/definition.ts).

```ts
export type EventKind = "notification" | "transformation" | "decision" | "barrier";

export interface HookSpec<P, R = void, C = HookContext> {
    payload: P;
    result: R;
    context: C;
}

export interface EventMap {
}

export type AnyEvent = keyof EventMap & string;

export type PayloadOf<N extends AnyEvent> = EventMap[N]["payload"];

export type ResultOf<N extends AnyEvent> = EventMap[N]["result"];

export type ContextOf<N extends AnyEvent> = EventMap[N]["context"];

export interface HookOptions {
    kind?: EventKind;
    version?: number;
}

export interface EventContext {
    controllerId?: string;
    agentId?: string;
    sessionId?: string;
    scope?: JsonObject;
    threadId?: string;
    streamId?: string | null;
    handleId?: string;
    sequence?: number;
    timestamp?: string;
    checkpointRevision?: number;
}

export type StreamEvent = {
    [N in AnyEvent]: EventEnvelope<PayloadOf<N>, N>;
}[AnyEvent];
```

### PluginContext và hook context

Nguồn: [packages/core/src/plugins/context.ts](packages/core/src/plugins/context.ts).

```ts
export type Disposer = () => void | Promise<void>;
/** Read access to capabilities captured for the current hook execution. */
export interface CapabilityRegistry {
    get<T = unknown>(kind: string, id: string): T | undefined;
    list<T = unknown>(kind: string): readonly T[];
}
/** Controls that do not wait for completion of the active execution. */
export type SessionHookHandle = Pick<Session, "id" | "scope" | "model" | "thread" | "followUp" | "state" | "isIdle" | "isDisposed">;
export type ThreadHookHandle = Pick<Thread, "id" | "scope" | "snapshot" | "getHistory" | "getCheckpoint" | "listCheckpoints" | "listInterrupts">;
export interface HookContext {
    readonly registry: CapabilityRegistry;
    readonly sessionId?: string;
    readonly signal?: AbortSignal;
    readonly session?: SessionHookHandle;
    readonly thread?: ThreadHookHandle;
    readonly [key: string]: unknown;
}
export interface SessionHookContext extends HookContext {
    readonly session: SessionHookHandle;
}
export interface ThreadHookContext extends HookContext {
    readonly thread: ThreadHookHandle;
}
/** Durable execution state available at lifecycle observations, without control services. */
export interface StateHookContext extends HookContext {
    readonly state: PluginStateContext;
}
export type EventHandler<D extends AnyEvent> = (event: EventEnvelope<PayloadOf<D>, D>, context: ContextOf<D>) => ResultOf<D> | void | Promise<ResultOf<D> | void>;
export interface PluginContext {
    /** Registers an Agent owned by this plugin; shutdown follows plugin disposal. */
    readonly agent: {
        register(agent: Agent): void;
    };
    readonly effects: {
        register(definition: EffectDefinition): void;
    };
    readonly interruptions: {
        register(definition: InterruptionDefinition): void;
    };
    readonly state: {
        define<T extends JsonValue>(definition: Omit<PluginStateDefinition<T>, "pluginId">): PluginStateDefinition<T>;
    };
    readonly storage: {
        register(backend: StorageBackend): void;
        readonly records: RecordStore;
    };
    readonly tools: {
        register(tool: Tool): void;
    };
    readonly models: {
        register(provider: ModelProviderRegistration): void;
    };
    hook<D extends AnyEvent>(name: D, handler: EventHandler<D>, options?: HookOptions): Disposer;
    emit<D extends AnyEvent>(definition: D, payload: PayloadOf<D>): Promise<ResultOf<D>>;
    defer(disposer: Disposer): void;
    readonly registry: {
        register(kind: string, id: string, value: unknown, version?: number): void;
    };
}
/** Instance contract implemented by built-in and user-defined plugin classes. */
export interface Plugin {
    readonly id: string;
    readonly version?: number;
    readonly configurationId?: string;
    setup(tessar: PluginContext): void | Disposer | Promise<void | Disposer>;
}
```

### Event maps, payloads và quyết định theo boundary

Nguồn: `packages/core/dist/events/type.d.ts`. `PartEvent<N>` nằm trong model contract bên dưới. Các alias `Transform`, `Decision`, `PartHooks` chỉ giúp đọc hình dạng EventMap, không phải root exports.

```ts
export type OperationDecision = {
    decision: "allow" | "deny";
    reason?: string;
};
export type OperationEvent = "session.model.before-change" | "session.thread.before-switch" | "thread.before-fork" | "thread.before-rename" | "thread.before-delete";
export interface QueuedInputReceipt {
    id: string;
    threadId: string;
}
export interface ExecutionReceipt {
    streamId: string;
    threadId: string;
}
export type SuspendDecision = {
    decision: "suspend";
    definitionId: string;
    payload: JsonValue;
    pluginId: string;
    definitionVersion: number;
};
export type StreamDecision = {
    decision: "allow" | "deny" | "stop";
    reason?: string;
} | SuspendDecision;
export type ToolDecision = StreamDecision;
export type TurnDecision = {
    decision: "allow" | "continue" | "deny" | "stop";
    reason?: string;
} | SuspendDecision;
export type ModelSelectionDecision = {
    decision: "allow";
} | {
    decision: "select";
    model: ModelRef;
} | SuspendDecision;
export type ModelRecoveryDecision = {
    decision: "deny" | "retry";
    reason?: string;
} | SuspendDecision;
export type ControlDecision = StreamDecision | TurnDecision | ModelSelectionDecision | ModelRecoveryDecision;
export type ResolvedDecision = Exclude<ControlDecision, SuspendDecision>;
export interface InputPreparation {
    messages: readonly MessageData[];
    handled?: {
        output: readonly MessageData[];
    };
    rejected?: ErrorInfo;
}
export interface ToolPreparation {
    tool: ToolDescription;
    toolCallId: string;
    toolExecutionId: string;
    arguments: JsonObject;
}
export interface StreamOutcome {
    /** Logical Stream lifetime; suspension does not finish it. */
    startedAt?: string;
    endedAt?: string | null;
    status: string;
    reason: string | null;
    output: readonly MessageData[];
    usage: UsageSummary;
    error: ErrorInfo | null;
    interrupt: InterruptRecord | null;
}
export declare const ready = "ready";
export declare const shutdown = "shutdown";
export declare const diagnostic = "diagnostic";
export declare const stateChanged = "state_changed";
export declare const thread: {
    readonly prepare: "thread.prepare";
    readonly started: "thread.started";
    readonly beforeFork: "thread.before-fork";
    readonly forked: "thread.forked";
    readonly beforeRename: "thread.before-rename";
    readonly renamed: "thread.renamed";
    readonly beforeDelete: "thread.before-delete";
    readonly deleted: "thread.deleted";
};
export declare const session: {
    readonly created: "session.created";
    readonly modelChanged: "session.model-changed";
    readonly threadSwitched: "session.thread-switched";
    readonly inputQueued: "session.input-queued";
    readonly inputDiscarded: "session.input-discarded";
    readonly closed: "session.closed";
    readonly model: {
        readonly beforeChange: "session.model.before-change";
        readonly optionsChanged: "session.model.options-changed";
    };
    readonly thread: {
        readonly beforeSwitch: "session.thread.before-switch";
    };
};
export declare const input: {
    readonly prepare: "input.prepare";
    readonly received: "input.received";
};
export declare const stream: {
    readonly before: "stream.before";
    readonly started: "stream.started";
    readonly end: "stream.end";
    readonly error: "stream.error";
    readonly suspended: "stream.suspended";
    readonly resumed: "stream.resumed";
    readonly cancel: "stream.cancel";
};
export declare const turn: {
    readonly start: "turn.start";
    readonly end: "turn.end";
    readonly decision: "turn.decision";
};
export declare const context: {
    readonly prepare: "context.prepare";
};
export declare const model: {
    readonly select: "model.select";
    readonly start: "model.start";
    readonly end: "model.end";
    readonly response: "model.response";
    readonly usage: "model.usage";
    readonly error: "model.error";
    readonly recover: "model.recover";
};
export declare const provider: {
    readonly request: "provider.request";
};
export declare const message: {
    readonly prepare: "message.prepare";
    readonly committed: "message.committed";
};
export declare const text: {
    readonly start: "text.start";
    readonly delta: "text.delta";
    readonly end: "text.end";
};
export declare const reasoning: {
    readonly start: "reasoning.start";
    readonly delta: "reasoning.delta";
    readonly end: "reasoning.end";
};
export declare const tool: {
    readonly call: {
        readonly start: "tool.call.start";
        readonly end: "tool.call.end";
    };
    readonly prepare: "tool.prepare";
    readonly before: "tool.before";
    readonly start: "tool.start";
    readonly update: "tool.update";
    readonly end: "tool.end";
    readonly error: "tool.error";
    readonly result: "tool.result";
};
export declare const checkpoint: {
    readonly committed: "checkpoint.committed";
};
type Transform<P> = HookSpec<P, P, ExecutionHookContext>;
type Decision<P, D extends ControlDecision> = HookSpec<P, D, DecisionHookContext<D>>;
type PartHooks = {
    [N in import("../models/contract.js").ModelPartChunk["type"]]: HookSpec<import("../models/contract.js").PartEvent<N>>;
};
declare module "./definition.js" {
    interface EventMap extends PartHooks {
        state_changed: HookSpec<{
            state: RuntimeState;
        }>;
        "session.model.before-change": HookSpec<{
            previous: ModelRef;
            model: ModelRef;
            previousOptions?: JsonObject;
            options?: JsonObject;
        }, OperationDecision, SessionHookContext>;
        "session.thread.before-switch": HookSpec<{
            previousThreadId: string | null;
            threadId: string;
        }, OperationDecision, SessionHookContext>;
        "thread.before-fork": HookSpec<{
            threadId: string;
            options: ForkOptions;
        }, OperationDecision, ThreadHookContext>;
        "thread.before-rename": HookSpec<{
            threadId: string;
            title: string;
        }, OperationDecision, ThreadHookContext>;
        "thread.before-delete": HookSpec<{
            threadId: string;
            permanent?: boolean;
        }, OperationDecision, ThreadHookContext>;
        "thread.forked": HookSpec<{
            threadId: string;
            forkedThreadId: string;
        }, void, ThreadHookContext>;
        "thread.renamed": HookSpec<{
            threadId: string;
            title: string;
        }, void, ThreadHookContext>;
        "thread.deleted": HookSpec<{
            threadId: string;
            permanent?: boolean;
        }, void, ThreadHookContext>;
        "session.created": HookSpec<{
            model: ModelRef;
        }, void, SessionHookContext>;
        "session.model-changed": HookSpec<{
            previous: ModelRef;
            model: ModelRef;
            previousOptions?: JsonObject;
            options?: JsonObject;
        }, void, SessionHookContext>;
        "session.model.options-changed": HookSpec<{
            model: ModelRef;
            previousOptions?: JsonObject;
            options?: JsonObject;
        }, void, SessionHookContext>;
        "session.thread-switched": HookSpec<{
            previousThreadId: string | null;
            threadId: string;
        }, void, SessionHookContext>;
        "session.input-queued": HookSpec<{
            receipt: QueuedInputReceipt;
        }, void, SessionHookContext>;
        "session.input-discarded": HookSpec<{
            receipt: QueuedInputReceipt;
            cause: string;
        }, void, SessionHookContext>;
        "session.closed": HookSpec<{}, void, SessionHookContext>;
        diagnostic: HookSpec<{
            error: ErrorInfo;
        }>;
        ready: HookSpec<{
            agentId: string;
        }>;
        shutdown: HookSpec<{}>;
        "thread.prepare": HookSpec<CreateThreadOptions, CreateThreadOptions>;
        "thread.started": HookSpec<ThreadInfo>;
        "input.prepare": Transform<InputPreparation>;
        "input.received": HookSpec<{
            messages: readonly MessageData[];
        }>;
        "stream.before": Decision<{
            input: readonly MessageData[];
        }, StreamDecision>;
        "stream.started": HookSpec<{
            modelRef: ModelRef;
            checkpointId: string;
            startedAt?: string;
        }>;
        "stream.end": HookSpec<StreamOutcome>;
        "stream.error": HookSpec<{
            /** Consumer errors detach delivery without failing the execution. Defaults to execution. */
            target?: "execution" | "consumer";
            error: ErrorInfo;
            lastKnownCheckpointId: string | null;
            persistedStatus: string | null;
            startedAt?: string;
            endedAt?: string | null;
        }>;
        "stream.suspended": HookSpec<{
            checkpointId: string;
            interrupt: InterruptRecord;
        }>;
        "stream.resumed": HookSpec<{
            checkpointId: string;
            interruptId: string | null;
            reason: string;
        }>;
        "turn.start": HookSpec<{
            turnId: string;
            index: number;
            startedAt?: string;
        }, void, import("../plugins/context.js").StateHookContext>;
        "turn.end": HookSpec<{
            turnId: string;
            usage: UsageSummary;
            startedAt?: string;
            endedAt?: string | null;
        }>;
        "turn.decision": Decision<{
            turnId: string;
            hadTools: boolean;
        }, TurnDecision>;
        "context.prepare": Transform<ModelRequest>;
        "model.select": Decision<{
            model: ModelRef;
        }, ModelSelectionDecision>;
        "provider.request": Transform<ProviderRequest>;
        "model.start": HookSpec<{
            attemptId: string;
            startedAt?: string;
            model: ModelRef;
            request?: ModelRequest;
            purpose?: "primary" | "auxiliary";
            turnId?: string;
            parentToolExecutionId?: string | null;
        }>;
        "model.end": HookSpec<{
            attemptId: string;
            response: ModelResponse;
            purpose?: "primary" | "auxiliary";
            startedAt?: string;
            endedAt?: string | null;
        }>;
        "model.response": Transform<ModelResponse>;
        "model.usage": HookSpec<{
            attemptId: string;
            usage: ModelUsage;
            purpose?: "primary" | "auxiliary";
        }>;
        "model.error": HookSpec<{
            attemptId: string;
            error: ErrorInfo;
            purpose?: "primary" | "auxiliary";
            startedAt?: string;
            endedAt?: string | null;
        }>;
        "model.recover": Decision<{
            attemptId: string;
            error: ErrorInfo;
        }, ModelRecoveryDecision>;
        "message.prepare": Transform<MessageData>;
        "message.committed": HookSpec<{
            message: MessageData;
            checkpointId: string;
        }>;
        "tool.prepare": Transform<ToolPreparation>;
        "tool.before": Decision<ToolPreparation, ToolDecision>;
        "tool.start": HookSpec<{
            toolExecutionId: string;
            startedAt?: string | null;
            toolCallId: string;
            turnId?: string;
            name?: string;
            arguments?: JsonObject;
        }>;
        "tool.update": HookSpec<{
            toolExecutionId: string;
            progress: JsonValue;
        }>;
        "tool.end": HookSpec<{
            toolExecutionId: string;
            toolCallId: string;
            result: MessageData;
            status: string;
            /** Execution times; notification may follow ordered result publication. */
            startedAt?: string | null;
            endedAt?: string | null;
        }>;
        "tool.error": HookSpec<{
            toolExecutionId: string;
            error: ErrorInfo;
            startedAt?: string | null;
            endedAt?: string | null;
        }>;
        "tool.result": Transform<MessageData>;
        "stream.cancel": HookSpec<{
            reason: string;
        }>;
        "checkpoint.committed": HookSpec<{
            checkpointId: string;
            revision: number;
        }>;
    }
}
/** Dispatch behavior is internal metadata; public event identifiers are strings. */
export declare const hookKinds: Readonly<Record<string, EventKind>>;
export declare const ToolDecision: {
    allow: () => OperationDecision;
    deny: (reason: string) => OperationDecision;
};
export declare const TurnDecision: {
    continue: () => {
        decision: "continue";
    };
    stop: (reason: string) => {
        decision: "stop";
        reason: string;
    };
};
export declare const InputDecision: {
    continue: (messages: readonly MessageData[]) => InputPreparation;
    handled: (outcome: {
        output: readonly MessageData[];
    }) => InputPreparation;
    reject: (error: ErrorInfo) => InputPreparation;
};
```

### Plugin state definition

Nguồn: [packages/core/src/state/plugin-state.ts](packages/core/src/state/plugin-state.ts).

```ts
export interface PluginStateDefinition<T extends JsonValue = JsonValue> {
    pluginId: string;
    namespace: string;
    schemaVersion: number;
    initial: T;
    migrate?: (value: JsonValue, fromVersion: number) => T;
    fork?: "copy" | "reset" | ((value: T, context: {
        sourceThreadId: string;
        targetThreadId: string;
    }) => T);
}

export declare function definePluginState<T extends JsonValue>(definition: PluginStateDefinition<T>): PluginStateDefinition<T>;
```

### PluginStateContext — view public

Contract được mở rộng ở đây để không yêu cầu import class serialization nội bộ.
`withOwner` nhận Thread/Stream/Turn; agent/session dùng CAS qua `owned`.

```ts
interface PluginStateContext {
  get<T extends JsonValue>(definition: PluginStateDefinition<T>): T;
  update<T extends JsonValue>(definition: PluginStateDefinition<T>, value: T | ((previous: T) => T)): void;
  commit(): Promise<string>;
  withOwner(owner: { type: "thread" | "stream" | "turn" | "agent" | "session"; id: string }): PluginStateContext;
  owned(owner: { type: "agent" | "session"; id: string }): {
    read<T extends JsonValue>(definition: PluginStateDefinition<T>): Promise<{ value: T; revision: number; schemaVersion: number }>;
    update<T extends JsonValue>(definition: PluginStateDefinition<T>, expectedRevision: number, value: T): Promise<{ value: T; revision: number }>;
  };
}
```

### Effects và tracked services

Nguồn: [packages/core/src/engine/tracked-effects.ts](packages/core/src/engine/tracked-effects.ts).

```ts
export interface EffectContext {
    signal: AbortSignal;
    threadId: string;
    streamId: string;
    turnId: string | null;
    toolExecutionId?: string;
    operationId: string;
    key: string;
}

export interface EffectDefinition<I = any, O = any> {
    id: string;
    version: number;
    input: InputDefinition<I>;
    output: InputDefinition<O>;
    execute: (input: I, context: EffectContext) => Promise<O>;
    reconcile?: (operation: {
        input: I;
        key: string;
        id: string;
    }) => Promise<{
        status: "completed";
        output: O;
    } | {
        status: "safeToRetry";
    } | {
        status: "unknown";
    }>;
}

export declare function defineEffect<I, O>(definition: EffectDefinition<I, O>): EffectDefinition<I, O>;

export interface TrackedServices {
    models: {
        stream(request: ModelRequest): AsyncIterable<ModelChunk>;
    };
    effects: {
        execute<I, O>(definition: EffectDefinition<I, O>, input: I, options: {
            key: string;
        }): Promise<O>;
    };
    events: {
        emit<D extends AnyEvent>(definition: D, payload: PayloadOf<D>): Promise<void>;
    };
}

export interface ExecutionHookContext extends HookContext, TrackedServices {
    readonly state: PluginStateContext;
    readonly signal: AbortSignal;
    readonly threadId: string;
    readonly streamId: string;
}
```

### Interruption definition và decision context

Nguồn: [packages/core/src/engine/interrupt.ts](packages/core/src/engine/interrupt.ts).

```ts
export interface InterruptionDefinition<R = any, D extends ResolvedDecision = ResolvedDecision, P extends JsonValue = JsonValue> {
    readonly id: string;
    readonly version: number;
    readonly response: InputDefinition<R>;
    readonly payload?: InputDefinition<P>;
    readonly resolve: (response: R, payload: P) => D;
}

export interface DecisionHookContext<D extends ControlDecision = ControlDecision> extends ExecutionHookContext {
    readonly state: PluginStateContext;
    readonly signal: AbortSignal;
    readonly threadId: string;
    readonly streamId: string;
    suspend<R, P extends JsonValue>(definition: InterruptionDefinition<R, Exclude<D, SuspendDecision>, P>, payload: P): SuspendDecision;
}

export declare function defineInterruption<R, D extends ResolvedDecision, P extends JsonValue = JsonValue>(definition: InterruptionDefinition<R, D, P>): InterruptionDefinition<R, D, P>;
```

### Model adapter/request/response contract

Nguồn: [packages/core/src/models/contract.ts](packages/core/src/models/contract.ts).

```ts
export interface ModelRef {
    providerId: string;
    modelId: string;
    /** Non-secret identity of a concrete connection, when supplied by an adapter. */
    connectionId?: string;
}
export interface ModelConnectionDescriptor {
    providerId: string;
    connectionId: string;
    protocol: string;
    endpoint: string;
}
export interface ToolDescription {
    name: string;
    description: string;
    inputSchema: JsonObject;
}
export interface ModelRequest {
    model: ModelRef;
    instructions: Instruction;
    messages: readonly MessageData[];
    tools: readonly ToolDescription[];
    options?: JsonObject;
}
export interface ModelCallContext {
    signal: AbortSignal;
    /** Observation clock supplied by the runtime. */
    now?(): string;
    /** Transform an encoded JSON body immediately before invoking the provider SDK. */
    prepareRequest?(protocol: string, body: JsonObject): Promise<JsonObject>;
}
export interface ProviderRequest {
    model: ModelRef;
    protocol: string;
    attemptId: string;
    purpose: "primary" | "auxiliary";
    body: JsonObject;
}
export interface ModelResponse {
    message: MessageData;
    usage?: ModelUsage;
    finishReason?: string;
    providerRequestId?: string;
}
export interface PartIdentity {
    messageId: string;
    partId: string;
    partIndex: number;
}
export interface PartTiming {
    startedAt: string;
    boundary: "provider" | "observed";
}
export type ModelPartChunk = {
    [K in "text" | "reasoning"]: (PartIdentity & PartTiming & {
        type: `${K}.start`;
    }) | (PartIdentity & {
        type: `${K}.delta`;
        delta: string;
    }) | (PartIdentity & PartTiming & {
        type: `${K}.end`;
        endedAt: string;
        status: "completed" | "interrupted";
        text: string;
    });
}["text" | "reasoning"] | (PartIdentity & PartTiming & {
    type: "tool.call.start";
    toolCallId?: string;
    name?: string;
}) | (PartIdentity & PartTiming & {
    type: "tool.call.end";
    endedAt: string;
} & ({
    status: "completed";
    toolCallId: string;
    name: string;
    arguments: JsonObject;
} | {
    status: "interrupted";
    toolCallId?: string;
    name?: string;
}));
type PartPayload<C> = C extends ModelPartChunk ? Omit<C, "type"> : never;
export type PartEvent<N extends ModelPartChunk["type"]> = PartPayload<Extract<ModelPartChunk, {
    type: N;
}>> & {
    attemptId: string;
    purpose: "primary" | "auxiliary";
    parentToolExecutionId: string | null;
};
export type ModelChunk = ModelPartChunk | {
    type: "usage";
    usage: ModelUsage;
} | {
    type: "response";
    response: ModelResponse;
};
export interface ModelAdapter {
    readonly ref: ModelRef;
    readonly connection?: ModelConnectionDescriptor;
    readonly options?: object;
    /** Select another model without changing credentials, endpoint or client. */
    withModel?(modelId: string): ModelAdapter;
    /** Map a supported effort level into this adapter's native request options. */
    effortOptions?(level: string, options: JsonObject): JsonObject;
    validate(request: ModelRequest): void;
    stream(request: ModelRequest, context: ModelCallContext): AsyncIterable<ModelChunk>;
}
export type ModelOptions<M> = M extends {
    readonly options: infer O;
} ? Partial<O> : JsonObject;
export interface ModelProviderRegistration {
    id: string;
    create(modelId: string): ModelAdapter;
    metadata?: MetadataResolver;
    endpoint?: string;
    metadataPartition?: string;
    catalogModelRef?: (ref: ModelRef) => ModelRef | null;
    catalogMappingVersion?: number;
}
```

### Model profile và metadata

Nguồn: [packages/core/src/models/profile.ts](packages/core/src/models/profile.ts).

```ts
export interface ModelPricing {
    currency: string;
    basis: "million-tokens";
    type: "flat" | "tiered";
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    reasoning: number | null;
    tiers?: readonly {
        condition: JsonValue;
        rates: JsonValue;
    }[];
}

export interface ProfileMetadata {
    completeness: "complete" | "partial" | "unavailable";
    freshness: "fresh" | "stale" | "unknown";
    fetchedAt: string | null;
    sourceRevision: string | null;
    provenance: Readonly<Record<string, string>>;
}

export interface ModelProfile extends ModelRef {
    name: string | null;
    contextWindow: number | null;
    maxInputTokens: number | null;
    maxOutputTokens: number | null;
    capabilities: {
        tools: boolean | null;
        reasoning: boolean | null;
        structuredOutput: boolean | null;
        imageInput: boolean | null;
        audioInput: boolean | null;
        audioOutput: boolean | null;
    };
    pricing: ModelPricing | null;
    metadata: ProfileMetadata;
}

export interface Model {
    readonly ref: Readonly<ModelRef>;
    profile(): Readonly<ModelProfile>;
    refreshProfile(options?: {
        signal?: AbortSignal;
    }): Promise<ModelProfile>;
}

export type ProfilePatch = Partial<Omit<ModelProfile, "capabilities" | "metadata">> & {
    capabilities?: Partial<ModelProfile["capabilities"]>;
    metadata?: Partial<ProfileMetadata>;
};

export interface MetadataResolver {
    resolve(ref: ModelRef, options: {
        signal?: AbortSignal;
    }): Promise<ProfilePatch>;
}
```

### Catalog data nhận bởi ProfileResolver

Nguồn: [packages/core/src/models/catalog.ts](packages/core/src/models/catalog.ts).

```ts
export interface CatalogSnapshot {
    revision: string;
    fetchedAt: string;
    entries: Record<string, Record<string, ProfilePatch>>;
    source?: string;
}
```

### State, checkpoint và dữ liệu Session

Nguồn: [packages/core/src/state/schema.ts](packages/core/src/state/schema.ts).

```ts
export type Scope = Readonly<Record<string, string | number | boolean>>;

export interface PluginStateSnapshot {
    pluginId: string;
    namespace: string;
    ownerType: "thread" | "stream" | "turn" | "agent" | "session";
    ownerId: string;
    schemaVersion: number;
    revision: number;
    data: JsonValue;
}

export interface ThreadState {
    instructions: Instruction | null;
    scope: Scope;
    metadata: JsonObject;
    messages: readonly MessageData[];
    pluginStates: readonly PluginStateSnapshot[];
}

export declare const ExecutionPhase: {
    readonly BeforeTurn: "BeforeTurn";
    readonly BeforeModel: "BeforeModel";
    readonly ModelPending: "ModelPending";
    readonly BeforeTool: "BeforeTool";
    readonly ToolPending: "ToolPending";
    readonly TurnBoundary: "TurnBoundary";
    readonly Suspended: "Suspended";
};

export declare const ExecutionPhase: {
    readonly BeforeTurn: "BeforeTurn";
    readonly BeforeModel: "BeforeModel";
    readonly ModelPending: "ModelPending";
    readonly BeforeTool: "BeforeTool";
    readonly ToolPending: "ToolPending";
    readonly TurnBoundary: "TurnBoundary";
    readonly Suspended: "Suspended";
};

export interface StreamLimits {
    maxTurns: number;
    maxModelAttempts: number;
    maxToolCalls: number;
}

export interface StreamBudgetState {
    turns: number;
    modelAttempts: number;
    toolCalls: number;
    limits: StreamLimits;
}

export interface RegistrationRequirement {
    pluginId: string;
    kind: string;
    id: string;
    version: number;
    requiredForContinuation: boolean;
    pluginVersion?: number;
    configurationId?: string | null;
}

export interface HandlerCursor {
    eventId: string;
    handlerId: string;
    nextIndex: number;
    payload: JsonValue;
    decisions: readonly JsonValue[];
}

export interface ExecutionPosition {
    pendingSignals?: readonly MessageData[];
    timing?: {
        completedActiveMs: number;
        segmentOpen: boolean;
        complete: boolean;
    };
    streamId: string;
    turnId: string | null;
    phase: ExecutionPhase;
    modelRef: ModelRef;
    modelConnection?: ModelConnectionDescriptor;
    modelOptions?: JsonObject;
    baseInstructions: Instruction;
    pendingToolExecutionIds: readonly string[];
    pendingInterruptId: string | null;
    handlerCursor: HandlerCursor | null;
    budgets: StreamBudgetState;
    registryManifest: readonly RegistrationRequirement[];
}

export type CheckpointCause = "ThreadCreated" | "InputCommitted" | "MessageCommitted" | "ExecutionTransition" | "PluginStateCommitted" | "Suspended" | "Resumed" | "Terminal" | "ForkCreated";

export interface Checkpoint {
    id: string;
    threadId: string;
    parentCheckpointId: string | null;
    revision: number;
    schemaVersion: 1;
    createdAt: string;
    state: ThreadState;
    execution: ExecutionPosition | null;
    cause: CheckpointCause;
}

export interface ThreadInfo {
    id: string;
    scope: Scope;
    metadata: JsonObject;
    revision: number;
    currentCheckpointId: string;
    activeStreamId: string | null;
    createdAt: string;
    updatedAt: string;
    parentThreadId: string | null;
    sourceCheckpointId: string | null;
    deleted: boolean;
}

export interface InterruptRecord {
    kind?: "decision" | "tool-result";
    id: string;
    threadId: string;
    streamId: string;
    checkpointId: string;
    definitionId: string;
    definitionVersion: number;
    pluginId: string;
    payload: JsonValue;
    responseSchema: JsonObject;
    actionRef: JsonObject | null;
    status: "pending" | "resolved" | "cancelled";
    response: JsonValue | null;
    resolvedDecision: JsonValue | null;
    createdAt: string;
    resolvedAt: string | null;
    revision: number;
}

export interface RecordTypes {
    streams: StreamRecord;
    turns: TurnRecord;
    model_attempts: ModelAttemptRecord;
    tool_executions: ToolExecutionRecord;
    interrupts: InterruptRecord;
}

export type RecordKind = keyof RecordTypes;

export type RecordEntry = {
    [K in RecordKind]: {
        kind: K;
        id: string;
        threadId: string;
        data: RecordTypes[K];
    };
}[RecordKind];

export interface PageOptions {
    cursor?: string;
    limit?: number;
}

export interface StateQuery {
    scope?: Scope;
}

export interface Page<T> {
    items: readonly T[];
    nextCursor: string | null;
}

export interface HistoryOptions extends PageOptions {
    atCheckpointId?: string;
}

export interface HistoryDataPage extends Page<MessageData> {
    checkpointId: string;
    revision: number;
}

export interface CheckpointInfo {
    id: string;
    threadId: string;
    revision: number;
    createdAt: string;
    cause: string;
    forkable: boolean;
    unsafeReason: string | null;
}

export interface RecordQuery extends PageOptions {
    streamId?: string;
    turnId?: string;
    status?: string;
    atCheckpointId?: string;
}

export interface StoredModelSelection {
    ref: ModelRef;
    options?: JsonObject;
    connection?: ModelConnectionDescriptor;
}

export interface SessionRecord {
    id: string;
    agentId: string;
    scope: Scope;
    metadata: JsonObject;
    selectedThreadId: string | null;
    selectedModel: StoredModelSelection;
    revision: number;
    createdAt: string;
    updatedAt: string;
}
```

### Trace records và status

Nguồn: [packages/core/src/trace/records.ts](packages/core/src/trace/records.ts).

```ts
export type StreamStatus = "pending" | "running" | "suspended" | "interrupted" | "completed" | "stopped" | "failed" | "cancelled";

export interface StreamRecord {
    outputMessageIds: readonly string[];
    id: string;
    threadId: string;
    scope: JsonObject;
    triggerMessageId: string | null;
    status: StreamStatus;
    stopReason: string | null;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    error: ErrorInfo | null;
    directUsage: UsageSummary;
}

export interface TurnRecord {
    id: string;
    streamId: string;
    scope: JsonObject;
    index: number;
    contextRevision: number;
    assistantMessageId: string | null;
    status: string;
    stopReason: string | null;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    error: ErrorInfo | null;
    usage: UsageSummary;
}

export interface ModelAttemptRecord {
    id: string;
    turnId: string;
    streamId: string;
    scope: JsonObject;
    callId: string;
    attemptIndex: number;
    purpose: "primary" | "auxiliary";
    parentToolExecutionId: string | null;
    providerId: string;
    modelId: string;
    providerRequestId: string | null;
    responseMessageId: string | null;
    contextRevision: number;
    startedAt: string;
    firstOutputAt: string | null;
    endedAt: string | null;
    durationMs: number | null;
    timeToFirstOutputMs: number | null;
    status: string;
    finishReason: string | null;
    error: ErrorInfo | null;
    usage: ModelUsage;
}

export interface ToolExecutionRecord {
    resume?: {
        interruptId: string;
        value: JsonValue;
    };
    id: string;
    turnId: string;
    streamId: string;
    scope: JsonObject;
    toolCallId: string;
    parentToolExecutionId: string | null;
    toolName: string;
    arguments: JsonObject;
    policyDecision: {
        decision: "allowed" | "denied";
        reason?: string;
    } | null;
    status: "pending" | "suspended" | "resuming" | "running" | "succeeded" | "failed" | "denied" | "cancelled" | "interrupted";
    startedAt: string | null;
    endedAt: string | null;
    durationMs: number | null;
    resultMessageId: string | null;
    result: MessageData | null;
    error: ErrorInfo | null;
    idempotencyKey: string | null;
}
```

### Token usage

Nguồn: [packages/core/src/trace/usage.ts](packages/core/src/trace/usage.ts).

```ts
export declare const tokenMetrics: readonly ["inputTokens", "uncachedInputTokens", "outputTokens", "reasoningOutputTokens", "cacheReadInputTokens", "cacheWriteInputTokens", "totalTokens"];

export type TokenMetric = (typeof tokenMetrics)[number];

export type UsageSource = "provider" | "derived" | "estimated" | "unavailable";

export type TokenCounts = Record<TokenMetric, number | null>;

export interface ModelUsage extends TokenCounts {
    provenance: Record<TokenMetric, UsageSource>;
    providerDetails?: JsonValue;
}

export interface UsageMetricSummary {
    knownTotal: number | null;
    knownAttempts: number;
    totalAttempts: number;
    coverage: "complete" | "partial" | "unavailable";
}

export interface UsageSummary {
    metrics: Record<TokenMetric, UsageMetricSummary>;
}

export declare function normalizeUsage(input: Partial<TokenCounts>, providerDetails?: JsonValue): ModelUsage;

export declare function aggregateUsage(attempts: readonly {
    id: string;
    usage: ModelUsage;
}[]): UsageSummary;
```

### StorageBackend: tất cả port và parameter

Nguồn: [packages/core/src/state/storage-ports.ts](packages/core/src/state/storage-ports.ts).

```ts
export interface Lease {
    threadId: string;
    ownerToken: string;
    fencingToken: number;
    expiresAt: string;
}

export interface CommitBatch {
    commitId: string;
    threadId: string;
    expectedRevision: number;
    checkpoint: Checkpoint;
    records: readonly RecordEntry[];
    lineage?: {
        parentThreadId: string;
        sourceCheckpointId: string;
    };
    deleteThread?: boolean;
}

export interface CommitReceipt {
    commitId: string;
    threadId: string;
    revision: number;
    checkpointId: string;
}

export interface PublishRequest {
    commitId: string;
    threadId: string;
    expectedRevision: number;
    lease: Lease;
}

export interface ThreadStore {
    purge(id: string, query?: StateQuery): Promise<void>;
    get(id: string, options?: {
        includeDeleted?: boolean;
    }): Promise<ThreadInfo | null>;
    page(query: StateQuery & PageOptions): Promise<Page<ThreadInfo>>;
    list(query?: StateQuery): Promise<readonly ThreadInfo[]>;
}

export interface ExecutionStore {
    page<K extends RecordKind>(kind: K, threadId: string, query: RecordQuery): Promise<Page<RecordTypes[K]>>;
    get<K extends RecordKind>(kind: K, id: string, options?: {
        threadId?: string;
        atCheckpointId?: string;
    }): Promise<RecordTypes[K] | null>;
    listRecords<K extends RecordKind>(kind: K, threadId: string, options?: {
        atCheckpointId?: string;
    }): Promise<readonly RecordTypes[K][]>;
}

export interface CheckpointStore {
    page(threadId: string, options: PageOptions): Promise<Page<CheckpointInfo>>;
    history(threadId: string, options: HistoryOptions, query?: StateQuery): Promise<HistoryDataPage>;
    get(id: string): Promise<Checkpoint | null>;
    list(threadId: string): Promise<readonly Checkpoint[]>;
}

export interface CommitPort {
    stage(batch: CommitBatch): Promise<void>;
    publish(request: PublishRequest): Promise<CommitReceipt>;
    lookupCommit(id: string): Promise<CommitReceipt | null>;
}

export interface OwnershipPort {
    acquire(request: {
        threadId: string;
        ownerToken: string;
        ttlMs: number;
    }): Promise<Lease>;
    renew(lease: Lease, ttlMs: number): Promise<Lease>;
    release(lease: Lease): Promise<void>;
}

export interface StorageBackend {
    readonly records: RecordStore;
    readonly sessions: {
        get(id: string, query?: StateQuery): Promise<SessionRecord | null>;
        page(query: StateQuery & PageOptions & {
            agentId: string;
        }): Promise<Page<SessionRecord>>;
        compareAndSet(value: SessionRecord, expectedRevision: number): Promise<void>;
    };
    readonly ownedState: {
        get(key: Pick<PluginStateSnapshot, "ownerType" | "ownerId" | "pluginId" | "namespace">): Promise<PluginStateSnapshot | null>;
        compareAndSet(state: PluginStateSnapshot, expectedRevision: number): Promise<void>;
    };
    readonly id: string;
    readonly capabilities: {
        durable: boolean;
        atomicPublish: true;
        coordination: "single-process" | "multi-process";
    };
    readonly threads: ThreadStore;
    readonly executions: ExecutionStore;
    readonly checkpoints: CheckpointStore;
    readonly commits: CommitPort;
    readonly ownership: OwnershipPort;
    close(): Promise<void>;
}
```

### Storage factory in-memory

Nguồn: [packages/core/src/state/memory-backend.ts](packages/core/src/state/memory-backend.ts).

```ts
export declare function createMemoryBackend(options?: {
    clock?: Clock;
}): StorageBackend;
```

### Storage helpers public

Nguồn: [packages/core/src/state/commit.ts](packages/core/src/state/commit.ts).

```ts
export declare function buildThreadInfo(batch: CommitBatch, head: ThreadInfo | null | undefined, stream: StreamRecord | null | undefined): ThreadInfo;

export declare function canonicalJson(value: unknown): string;

export declare const commitFingerprint: (batch: CommitBatch) => Promise<string>;

export declare function validateBatch(batch: CommitBatch): void;

// Dành cho tác giả backend: validate JSON/scope, tạo ID và timestamp nếu cần.
export declare function prepareStoredRecord(options: AppendRecordOptions, createdAt?: string): StoredRecord;
```

### Scope helpers

Nguồn: [packages/core/src/state/scope.ts](packages/core/src/state/scope.ts).

```ts
export declare function normalizeScope(value?: Scope): Scope;

export declare function matchesScope(state: Scope, filter?: Scope): boolean;
```

### Session validation cho backend

Nguồn: [packages/core/src/state/sessions.ts](packages/core/src/state/sessions.ts).

```ts
export declare function validateSession(value: SessionRecord, previous: SessionRecord | null, expected: number, thread: ThreadInfo | null): void;
```

### Paging helpers public

Nguồn: [packages/core/src/state/queries.ts](packages/core/src/state/queries.ts).

```ts
export interface HistoryPage extends Page<Message> {
    checkpointId: string;
    revision: number;
}

export declare function checkpointSafety(cp: Checkpoint): {
    forkable: boolean;
    unsafeReason: string | null;
};

export declare function limitOf(limit?: number): number;

export declare function encodeCursor(value: unknown): string;

export declare function decodeCursor(value: string): any;

export declare function compareOrdinal(a: string, b: string): number;

export declare function pageAfter(options: PageOptions, binding: string): [string, string] | null;

export declare function pageRows<T extends {
    id: string;
}>(rows: readonly T[], options?: PageOptions, binding?: string): Page<T>;

export declare function recordBinding(kind: RecordKind, threadId: string, query: RecordQuery): string;

export declare function historyCursor(id: string, options: HistoryOptions, query: StateQuery): {
    binding: string;
    cursor: {
        checkpointId: string;
        end: number;
    } | null;
};
```

### Fork options

Nguồn: [packages/core/src/state/fork.ts](packages/core/src/state/fork.ts).

```ts
export interface ForkOptions {
    id?: string;
    atCheckpointId?: string;
    atMessageId?: string;
    metadata?: JsonObject;
}
```

### Thread preparation options cho hook/testing

Nguồn: [packages/core/src/state/threads.ts](packages/core/src/state/threads.ts).

```ts
export interface CreateThreadOptions {
    id?: string;
    title?: string;
    scope?: Scope;
    instructions?: string | Instruction;
    messages?: readonly MessageData[];
    metadata?: JsonObject;
}
```

### JSON, clock, ID

Nguồn: [packages/core/src/json.ts](packages/core/src/json.ts).

```ts
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};

export type JsonObject = {
    readonly [key: string]: JsonValue;
};

export declare function assertJson(value: unknown, parents?: Set<object>): asserts value is JsonValue;

export declare function deepFreeze<T>(value: T): Readonly<T>;

export declare function immutable<T>(value: T): Readonly<T>;

export interface Clock {
    now(): string;
}

export interface IdGenerator {
    next(kind: string): string;
}

export declare const systemClock: Clock;

export declare const randomIds: IdGenerator;
```

### Model options snapshot

Nguồn: [packages/core/src/models/options.ts](packages/core/src/models/options.ts).

```ts
export declare function snapshotModelOptions(value: object): JsonObject;
```

### Errors

Nguồn: [packages/core/src/errors.ts](packages/core/src/errors.ts).

```ts
export interface ErrorOrigin {
    source: "tessar" | "provider" | "plugin" | "tool" | "storage" | "application";
    providerId?: string;
    modelId?: string;
    pluginId?: string;
    eventId?: string;
    toolName?: string;
    backendId?: string;
}

export interface ErrorInfo extends ErrorOrigin {
    name: string;
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
}

export interface TessarErrorOptions extends ErrorOptions {
    source?: ErrorOrigin["source"];
    details?: Record<string, unknown>;
}

export declare class TessarError extends Error {
    readonly code: string;
    readonly source: ErrorOrigin["source"];
    readonly details?: Record<string, unknown> | undefined;
    static isInstance<E extends TessarError>(this: abstract new (...args: any[]) => E, value: unknown): value is E;
    constructor(code: string, message: string, options?: TessarErrorOptions);
    toJSON(): ErrorInfo;
}

export declare function fail(code: string, message: string): never;

export declare function requireId(id: string, name?: string): string;

export declare function errorInfo(error: unknown, origin?: ErrorOrigin): ErrorInfo;

export declare function errorFromInfo(info: ErrorInfo): unknown;
```

`TessarError` là base cho các lỗi Tessar định nghĩa; `.source` phân biệt nguồn,
không suy từ quan hệ kế thừa. TypeSafeAPIError/TypeSafeResponseError kế thừa
`.isInstance()` và giữ source provider. Guard kiểm tra class thực tế, không so
name/errorId và không nhận JSON ErrorInfo là instance. Native cause/stack có trên
exception nhưng chưa được serialize vào ErrorInfo. Xem [hướng dẫn lỗi](../examples/guide/errors.md).

### PluginManager options

Nguồn: [packages/plugins/src/index.ts](packages/plugins/src/index.ts).

```ts
export interface PluginManagerOptions {
    directory: string;
    hostUrl?: string;
}
```

### Logger types

Nguồn: `packages/plugins/src/build-in/logger.ts` và `logger-transports.ts`.

```ts
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry extends EventContext {
    level: LogLevel;
    type: string;
    timestamp: string;
    payload: unknown;
}

export interface LoggerOptions {
    /** Minimum level sent to transports. Defaults to info. */
    level?: LogLevel;
    /** Defaults to a ConsoleTransport writing JSON to stderr. */
    transports?: readonly LogTransport[];
}

export interface LogTransport {
    write(entry: LogEntry): void | Promise<void>;
    close?(): void | Promise<void>;
}

export declare const logGroup: {
    readonly none: "none";
    readonly thread: "thread";
    readonly session: "session";
    readonly stream: "stream";
};

export type LogGroup = (typeof logGroup)[keyof typeof logGroup];

export interface FileTransportOptions {
    /** Full filename; its parent directory and extension are reused for groups. */
    path: string;
    /** Missing grouping IDs fall back to path. Defaults to logGroup.none. */
    groupBy?: LogGroup;
}

export declare class ConsoleTransport implements LogTransport {
    write(entry: LogEntry): void;
}

export declare class FileTransport implements LogTransport {
    constructor(options: FileTransportOptions);
    write(entry: LogEntry): Promise<void>;
    close(): Promise<void>;
}
```

### SQLite options

Nguồn: [packages/sqlite/src/backend.ts](packages/sqlite/src/backend.ts).

```ts
export interface SqliteStorageOptions {
    filename: string;
}

export declare function createSqliteBackend(options: SqliteStorageOptions): Promise<StorageBackend>;
```

### PostgreSQL options

Nguồn: [packages/postgresql/src/database.ts](packages/postgresql/src/database.ts).

```ts
export interface PostgresqlStorageOptions {
    connectionString: string;
    schema?: string;
    driverOptions?: Omit<PoolConfig, "connectionString">;
}
```

### MongoDB options

Nguồn: [packages/mongodb/src/database.ts](packages/mongodb/src/database.ts).

```ts
export interface MongoDBStorageOptions {
    uri: string;
    databaseName: string;
    clientOptions?: MongoClientOptions;
}
```

### Scripted model test options

Nguồn: [packages/core/src/testing/scripted-provider.ts](packages/core/src/testing/scripted-provider.ts).

```ts
export interface ModelScript {
    text?: string;
    response?: ModelResponse;
    usage?: Partial<TokenCounts>;
    chunks?: readonly ModelChunk[];
    error?: Error;
    gate?: Promise<void>;
}
```

### Storage conformance helpers

Nguồn: [packages/core/src/testing/storage-conformance.ts](packages/core/src/testing/storage-conformance.ts).

```ts
export declare function initialBatch(threadId?: string): CommitBatch;

export declare function storageConformance(name: string, factory: () => Promise<StorageBackend>): void;
```

### OpenAI provider option types

Nguồn: [packages/openai/src/provider.ts](packages/openai/src/provider.ts).

```ts
export type OpenAIAPI = "responses" | "chat-completions";

export type OpenAIModelOptions = Omit<ResponseCreateParamsStreaming, "model" | "input" | "instructions" | "tools" | "stream" | "background" | "conversation" | "previous_response_id" | "context_management">;

export type OpenAIChatModelOptions = Omit<ChatCompletionCreateParamsStreaming, "model" | "messages" | "tools" | "stream" | "functions" | "function_call" | "n"> & {
    n?: 1;
};

export type OpenAIProviderOptions<A extends OpenAIAPI = OpenAIAPI> = OpenAIOptions & {
    model: string;
    connectionId?: string;
} & (A extends "chat-completions" ? {
    api: "chat-completions";
} & OpenAIChatModelOptions : {
    api?: "responses";
} & OpenAIModelOptions);
```

### OpenAIOptions

Nguồn: [packages/openai/src/adapter.ts](packages/openai/src/adapter.ts).

```ts
export interface OpenAIOptions extends ClientOptions {
    providerId?: string;
    metadataPartition?: string;
}
```

### OpenAI SDK ClientOptions: toàn bộ field client

```ts
export interface ClientOptions {
    apiKey?: string | ApiKeySetter | null | undefined;
    adminAPIKey?: string | null | undefined;
    organization?: string | null | undefined;
    project?: string | null | undefined;
    webhookSecret?: string | null | undefined;
    baseURL?: string | null | undefined;
    dataResidency?: DataResidency | null | undefined;
    timeout?: number | undefined;
    fetchOptions?: MergedRequestInit | undefined;
    fetch?: Fetch | undefined;
    maxRetries?: number | undefined;
    defaultHeaders?: HeadersLike | undefined;
    defaultQuery?: Record<string, string | undefined> | undefined;
    dangerouslyAllowBrowser?: boolean | undefined;
    logLevel?: LogLevel | undefined;
    logger?: Logger | undefined;
    workloadIdentity?: WorkloadIdentity | X509WorkloadIdentity | undefined;
    x509Transport?: X509Transport | undefined;
    credential?: X509Credential | undefined;
    provider?: Provider | undefined;
}
```

### Responses: toàn bộ field body Tessar nhận ở provider

```ts
export interface ResponseCreateParamsBase {
    access_programs?: ResponseCreateParams.AccessPrograms;
    include?: Array<ResponseIncludable> | null;
    max_output_tokens?: number | null;
    metadata?: Shared.Metadata | null;
    moderation?: ResponseCreateParams.Moderation | null;
    parallel_tool_calls?: boolean | null;
    prompt?: ResponsePrompt | null;
    prompt_cache_key?: string | null;
    prompt_cache_options?: ResponseCreateParams.PromptCacheOptions;
    prompt_cache_retention?: 'in_memory' | '24h' | null;
    reasoning?: Shared.Reasoning | null;
    safety_identifier?: string | null;
    service_tier?: ServiceTier | null;
    store?: boolean | null;
    stream_options?: ResponseCreateParams.StreamOptions | null;
    temperature?: number | null;
    text?: ResponseTextConfig;
    tool_choice?: ToolChoiceOptions | ToolChoiceAllowed | ToolChoiceTypes | ToolChoiceFunction | ToolChoiceMcp | ToolChoiceCustom | ResponseCreateParams.SpecificProgrammaticToolCallingParam | ToolChoiceApplyPatch | ToolChoiceShell;
    top_logprobs?: number | null;
    top_p?: number | null;
    truncation?: 'auto' | 'disabled' | null;
    user?: string;
}
export declare namespace ResponseCreateParams {
    interface AccessPrograms {
        cyber?: 'standard' | 'daybreak_blue' | 'daybreak_red';
    }
    interface ContextManagement {
        type: string;
        compact_threshold?: number | null;
    }
    interface Moderation {
        model: string;
        policy?: Moderation.Policy | null;
    }
    namespace Moderation {
        interface Policy {
            input?: Policy.Input | null;
            output?: Policy.Output | null;
        }
        namespace Policy {
            interface Input {
                mode: 'score' | 'block';
            }
            interface Output {
                mode: 'score' | 'block';
            }
        }
    }
    interface PromptCacheOptions {
        comparison_response_id?: string | null;
        mode?: 'implicit' | 'explicit';
        prewarm?: boolean;
        ttl?: '30m';
    }
    interface StreamOptions {
        include_obfuscation?: boolean;
    }
    interface SpecificProgrammaticToolCallingParam {
        type: 'programmatic_tool_calling';
    }
    type ResponseCreateParamsNonStreaming = ResponsesAPI.ResponseCreateParamsNonStreaming;
    type ResponseCreateParamsStreaming = ResponsesAPI.ResponseCreateParamsStreaming;
}
```

### Chat Completions: toàn bộ field body Tessar nhận ở provider

```ts
export interface ChatCompletionCreateParamsBase {
    audio?: ChatCompletionAudioParam | null;
    frequency_penalty?: number | null;
    logit_bias?: {
        [key: string]: number;
    } | null;
    logprobs?: boolean | null;
    max_completion_tokens?: number | null;
    max_tokens?: number | null;
    metadata?: Shared.Metadata | null;
    modalities?: Array<'text' | 'audio'> | null;
    moderation?: ChatCompletionCreateParams.Moderation | null;
    parallel_tool_calls?: boolean;
    prediction?: ChatCompletionPredictionContent | null;
    presence_penalty?: number | null;
    prompt_cache_key?: string | null;
    prompt_cache_options?: ChatCompletionCreateParams.PromptCacheOptions;
    prompt_cache_retention?: 'in_memory' | '24h' | null;
    reasoning_effort?: Shared.ReasoningEffort | null;
    response_format?: Shared.ResponseFormatText | Shared.ResponseFormatJSONSchema | Shared.ResponseFormatJSONObject;
    safety_identifier?: string | null;
    seed?: number | null;
    service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority' | 'fast' | null;
    stop?: string | Array<string> | null;
    store?: boolean | null;
    stream_options?: ChatCompletionStreamOptions | null;
    temperature?: number | null;
    tool_choice?: ChatCompletionToolChoiceOption;
    top_logprobs?: number | null;
    top_p?: number | null;
    user?: string;
    verbosity?: 'low' | 'medium' | 'high' | null;
    web_search_options?: ChatCompletionCreateParams.WebSearchOptions;
}
export declare namespace ChatCompletionCreateParams {
    interface Function {
        name: string;
        description?: string;
        parameters?: Shared.FunctionParameters;
    }
    interface Moderation {
        model: string;
        policy?: Moderation.Policy | null;
    }
    namespace Moderation {
        interface Policy {
            input?: Policy.Input | null;
            output?: Policy.Output | null;
        }
        namespace Policy {
            interface Input {
                mode: 'score' | 'block';
            }
            interface Output {
                mode: 'score' | 'block';
            }
        }
    }
    interface PromptCacheOptions {
        mode?: 'implicit' | 'explicit';
        ttl?: '30m';
    }
    interface WebSearchOptions {
        search_context_size?: 'low' | 'medium' | 'high';
        user_location?: WebSearchOptions.UserLocation | null;
    }
    namespace WebSearchOptions {
        interface UserLocation {
            approximate: UserLocation.Approximate;
            type: 'approximate';
        }
        namespace UserLocation {
            interface Approximate {
                city?: string;
                country?: string;
                region?: string;
                timezone?: string;
            }
        }
    }
    type ChatCompletionCreateParamsNonStreaming = ChatCompletionsAPI.ChatCompletionCreateParamsNonStreaming;
    type ChatCompletionCreateParamsStreaming = ChatCompletionsAPI.ChatCompletionCreateParamsStreaming;
}
```

Chat options bổ sung `n?: 1`; field model của hai protocol được cấu hình riêng. SDK namespace `ChatCompletionCreateParams` trong các type dưới đây dùng cho Chat Completions. `ResponseCreateParams` dùng cho Responses.

### OpenAI nested option: Reasoning

```ts
export interface Reasoning {
    context?: 'auto' | 'current_turn' | 'all_turns' | null;
    effort?: ReasoningEffort | null;
    generate_summary?: 'auto' | 'concise' | 'detailed' | null;
    mode?: (string & {}) | 'standard' | 'pro';
    summary?: 'auto' | 'concise' | 'detailed' | null;
}
```

### OpenAI nested option: ReasoningEffort

```ts
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
```

### OpenAI nested option: ResponseFormatText

```ts
export interface ResponseFormatText {
    type: 'text';
}
```

### OpenAI nested option: ResponseFormatJSONObject

```ts
export interface ResponseFormatJSONObject {
    type: 'json_object';
}
```

### OpenAI nested option: ResponseFormatJSONSchema

```ts
export interface ResponseFormatJSONSchema {
    json_schema: ResponseFormatJSONSchema.JSONSchema;
    type: 'json_schema';
}
export declare namespace ResponseFormatJSONSchema {
    interface JSONSchema {
        name: string;
        description?: string;
        schema?: {
            [key: string]: unknown;
        };
        strict?: boolean | null;
    }
}
```

### Responses nested option: ResponseTextConfig

```ts
export interface ResponseTextConfig {
    format?: ResponseFormatTextConfig;
    verbosity?: 'low' | 'medium' | 'high' | null;
}
```

### Responses nested option: ResponseFormatTextConfig

```ts
export type ResponseFormatTextConfig = Shared.ResponseFormatText | ResponseFormatTextJSONSchemaConfig | Shared.ResponseFormatJSONObject;
```

### Responses nested option: ResponseFormatTextJSONSchemaConfig

```ts
export interface ResponseFormatTextJSONSchemaConfig {
    name: string;
    schema: {
        [key: string]: unknown;
    };
    type: 'json_schema';
    description?: string;
    strict?: boolean | null;
}
```


### Rendering snapshot types

```ts
export type RuntimePart = {
    readonly partId: string;
    readonly partIndex: number;
    readonly status: "streaming" | "completed" | "interrupted";
} & ({
    [K in "text" | "reasoning"]: {
        readonly type: K;
        readonly text: string;
    };
}["text" | "reasoning"] | {
    readonly type: "tool-call";
    readonly toolCallId?: string;
    readonly name?: string;
    readonly arguments?: import("./json.js").JsonObject;
});

export type RuntimeDraft = Omit<MessageData, "content"> & {
    readonly content: readonly RuntimePart[];
};

export type RuntimeMessage = Omit<MessageData, "content"> & {
    readonly content: readonly (ContentPart | RuntimePart)[];
};

export interface StateTool {
    readonly id: string;
    readonly toolCallId: string;
    readonly name: string;
    readonly status: string;
    readonly progress: JsonValue | null;
    readonly result: MessageData | null;
    readonly error: ErrorInfo | null;
}

export interface RuntimeState {
    readonly status: StreamStatus | "idle" | "closed";
    /** Committed messages and the current draft, in conversation order. */
    readonly messages: readonly RuntimeMessage[];
    readonly currentMessage: RuntimeDraft | null;
    readonly tools: readonly StateTool[];
    readonly interrupt: InterruptRecord | null;
    readonly queuedInputs: number;
    readonly error: ErrorInfo | null;
}
```

## OpenTelemetry tracing (`@tessar/opentelemetry`)

```ts
interface TraceAdapter {
  createExporter(): SpanExporter; // OpenTelemetry SDK exporter contract.
}
interface OpenTelemetryOptions {
  adapters: readonly TraceAdapter[]; // Required, nonempty.
  realtime?: boolean; // Default false; true exports each completed span immediately.
  serviceName?: string;
  traceName?: string;
  tags?: readonly string[];
}
class OpenTelemetryPlugin implements Plugin {
  readonly id = "opentelemetry";
  constructor(options: OpenTelemetryOptions);
  setup(tessar: PluginContext): Promise<void>;
}
interface OTLPOptions {
  endpoint?: string; // Complete OTLP/HTTP trace URL, including /v1/traces.
  headers?: Readonly<Record<string, string>>;
}
class OTLPAdapter implements TraceAdapter {
  constructor(options?: OTLPOptions);
  createExporter(): SpanExporter;
  protected mapSpan(span: ReadableSpan): ReadableSpan; // Override when extending.
}
interface LangfuseOptions {
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  prompt?: { name: string; version: number };
}
class LangfuseAdapter extends OTLPAdapter {
  constructor(options?: LangfuseOptions);
}
interface LaminarOptions {
  apiKey?: string;
  endpoint?: string;
}
class LaminarAdapter extends OTLPAdapter {
  constructor(options?: LaminarOptions);
}
```

`SpanExporter` and `ReadableSpan` above are external OTel SDK contracts, not
Tessar root exports. Platform options use environment fallbacks as documented in
the [package README](../packages/opentelemetry/README.md). Shared GenAI fields
cover identity, operations, usage, system instructions and typed input/output message parts. See the [guide](../examples/guide/opentelemetry.md)
for Agent/Session flows, destination setup and migration from `@tessar/langfuse`.

Each invocation has an Agent-rooted trace. Langfuse Sessions group traces by Tessar
Thread ID; the Tessar Session ID stays in observation metadata. Turn counters
persist per Thread. Resume/recovery gets a fresh trace segment and observations,
retaining logical Stream/Turn IDs rather than reusing ended parents.
