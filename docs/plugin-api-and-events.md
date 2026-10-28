# Tessar — Event hooks và Plugin API

Đối chiếu code và public declarations trong checkout ngày **2026-10-27**.
Tài liệu mô tả API hiện tại, không khẳng định mọi thay đổi đã có trên npm.
Chỉ liệt kê contract public và capability nhận qua context; không đưa engine,
host hay registry implementation nội bộ thành API sử dụng.

Nguồn: [PluginContext](../packages/core/src/plugins/context.ts),
[event definitions](../packages/core/src/events/definition.ts),
[event catalog](../packages/core/src/events/type.ts).
Xem [API reference đầy đủ](api-review.md) cho cấu trúc Message, ModelRequest,
StorageBackend, records và các parameter Session/Thread mở rộng.
Xem [audit phạm vi mở rộng](plugin-surface-audit.md) để phân biệt điểm cần giữ,
điểm trùng và điểm chưa chứng minh nhu cầu. Bảng contract bên dưới mô tả code
hiện tại, không khẳng định mọi event hiện tại đều nên giữ trong thiết kế tối thiểu.

Đọc nhanh: [chọn theo nhu cầu](#bắt-đầu-từ-nhu-cầu-không-từ-danh-sách-event),
[tra từng event](#5-toàn-bộ-event-built-in),
[phần trùng và giới hạn hiện tại](#11-eventapi-nào-trùng-hoặc-có-thể-gây-hiểu-nhầm).

## Bắt đầu từ nhu cầu, không từ danh sách event

Không cần sử dụng toàn bộ API trong tài liệu để làm một ứng dụng. Phân biệt ba
người sử dụng:

| Người sử dụng | Cần biết gì? |
| --- | --- |
| Dev dùng SDK xây ứng dụng | Provider, Agent, `stream()`/`generate()`; thêm Controller khi cần plugin, Session khi cần phiên làm việc |
| Dev viết plugin | `setup(tessar)` và đúng các registration/hook phục vụ khả năng muốn thêm |
| Người dùng ứng dụng đã đóng gói | Chọn, cài, cấu hình plugin qua khả năng ứng dụng cung cấp; không cần gọi hook hoặc học PluginContext |

Một người có thể vừa làm ứng dụng vừa viết plugin. Việc có Controller không bắt
buộc phải tạo Session; Agent đã gắn Controller vẫn dùng `stream()`/`generate()`.

### Chọn API theo việc cần làm

| Tôi muốn… | Bắt đầu bằng | Chỉ thêm khi cần |
| --- | --- | --- |
| Gọi model, dùng tool của ứng dụng | `new Agent({ model, tools })`, `createTool()` | Không cần bọc tool thành plugin |
| Render chat đang chạy, gồm text/thinking/tool/status | `state_changed`, đọc `event.payload.state` | `text.delta` / `reasoning.delta` khi tự quản lý việc ghép nội dung; không cần dựng lại state từ mọi event |
| Hiển thị chọn model hoặc danh sách cuộc trò chuyện | Session model/thread APIs, `session.modelChanged`, các notification Session tương ứng | Không dùng `state_changed` thay cho toàn bộ dữ liệu sidebar |
| Thêm tool sau khi ứng dụng đã đóng gói | `tessar.tools.register()` | PluginManager khi host cần load từ filesystem/npm |
| Thêm provider hoặc đổi nơi lưu state | `tessar.models.register()` / `tessar.storage.register()` | Không cần tự viết hook cho từng lần gọi model hoặc từng lần ghi DB |
| Thêm skill, memory vào context gửi model | `context.prepare` | `tessar.state.define()` nếu cần lưu tiến độ/dữ liệu plugin; dùng section `order` cho thứ tự instruction |
| Sửa body riêng của provider trước khi gửi | `provider.request` | Lọc theo model/provider/protocol; không đổi identity, connection hoặc tắt streaming |
| Compact history gửi model | `context.prepare` + plugin state lưu summary/mốc đã xử lý | Lời gọi model phụ nếu cách compact cần LLM; thay request không tự xóa history đã lưu |
| Kiểm soát tool được thấy hoặc được chạy | `context.prepare` để lọc danh sách; `tool.before` để cho phép/từ chối/tạm dừng thực thi | `tool.prepare` khi cần sửa arguments trước kiểm tra |
| Làm tool hỏi user | `context.suspend()` bên trong tool và `resume()` của tool | `interruptions.register()` cho policy yêu cầu approval từ decision hook, không bắt buộc với tool hỏi user |
| Ghi log hoặc gửi trace | Dùng LoggerPlugin / OpenTelemetryPlugin có sẵn | Chỉ nghe lifecycle model/tool/stream nếu tự viết exporter |
| Nhận tin từ background task hoặc dịch vụ ngoài | `agent.sendSignal()` với target phù hợp | `followUp()` khi muốn một input đợi lượt hiện tại kết thúc; `emit()` không thay thế hai API này |
| Làm delegate/subagent | Tạo Agent độc lập và tool điều phối; `tessar.agent.register()` nếu Agent do plugin cung cấp | Process, context mới/fork và trả kết quả do plugin quyết định |

Agent con không tự kế thừa hook của host. Plugin của user có thể tạo Controller
riêng cho Agent con với các plugin được chọn, không bắt buộc thêm Session.
`context.prepare` của Controller đó xử lý context cho loop của Agent con như
Agent thông thường. Xem [guide plugins](../examples/guide/plugins.md#change-a-provider-native-request).

Ví dụ UI dùng Session:

```ts
import { stateChanged } from "@tessar/core";

// session đã được tạo; render là hàm của ứng dụng.
const unsubscribe = session.subscribe(stateChanged, event => {
  render(event.payload.state);
});
// Khi UI không còn quan sát Session: unsubscribe();
```

UI cho Agent trực tiếp đọc cùng event từ Stream. Đây là snapshot runtime, không
phải yêu cầu framework frontend; Tessar không tự render terminal hay browser.

### Những API nâng cao có thể bỏ qua lúc đầu

| API | Chỉ cần khi… |
| --- | --- |
| `state.define` và `context.state.*` | Plugin có dữ liệu cần được khôi phục; ví dụ summary và mốc compact của từng Thread |
| `tessar.storage.records.append/get/list` | Lưu và truy vấn các record JSON độc lập, ví dụ lịch sử quyết định; không cần Thread hay execution, dùng sau initialize |
| `context.state.owned()` | Plugin cần state cấp Session/Agent, cập nhật bằng revision để phát hiện ghi đè đồng thời |
| `context.models.stream()` | Plugin/tool cần một lời gọi model phụ được ghi nhận attempt/usage; ví dụ tạo summary bằng LLM |
| `effects.register` / `context.effects.execute()` | Muốn lưu kết quả một thao tác ngoài theo key và đối soát khi không biết thao tác đã thành công chưa; không bắt buộc cho mọi tool/fetch |
| `interruptions.register()` | Policy ở decision hook cần dừng và khôi phục quyết định; ví dụ approval trước một tool |
| `registry.register/get/list` | Các plugin cần chia sẻ một capability tự định nghĩa; plugin độc lập không cần registry riêng |
| `tessar.emit()` | Các plugin trao đổi custom hook ở host; không cần context của một execution đang chạy |
| `context.events.emit()` | Custom notification cần đi theo execution hiện tại ra Stream/subscriber |
| `tessar.defer()` hoặc disposer trả từ `setup()` | Plugin mở tài nguyên cần cleanup khi detach/dispose; không cần cả hai cho cùng một tài nguyên |

Các tầng này không tự tạo background job, scheduler, memory hay subagent. Chúng
cấp điểm nối để plugin tự triển khai, không buộc mọi plugin theo một cách làm.

### Một lượt chạy đi qua những đâu?

Luồng chính dưới đây giúp chọn vị trí can thiệp; đây không phải danh sách mọi
notification/checkpoint hoặc nhánh retry, suspend, resume:

```text
input.prepare → stream.started → input.received → stream.before
  → turn.start
  → model.select → context.prepare
  → model.start → adapter encode → provider.request → SDK
  → text/reasoning/tool.call lifecycle / model.usage → model.response
  → message.prepare → message.beforeCommit → message.committed → model.end
  → nếu có tool: tool.prepare → tool.before → tool.start
                 → tool.update → tool.result → message.prepare/commit → tool.end
  → turn.end → turn.decision
  → turn tiếp theo hoặc stream.end
```

Một lần gửi input có thể sinh nhiều Turn; một Turn có thể có nhiều model attempt
do retry và lời gọi phụ. Event `tool.update` hay `model.usage` chỉ có khi có dữ
liệu tương ứng. Không phải event nào cũng xuất hiện trong mọi lần chạy. Xem mục 6
trước khi return một quyết định; không phải mọi decision hook đều dùng `deny`.

## 1. Plugin được gắn ở đâu?

Plugin là instance có `id` và `setup(tessar)`. Built-in và plugin tự viết dùng
cùng contract; không cần kế thừa base class hoặc khai báo `apiVersion`.

```ts
import {
  Controller, model, tool,
  type Plugin, type PluginContext,
} from "@tessar/core";

export class ObservePlugin implements Plugin {
  readonly id = "observe";

  setup(tessar: PluginContext): void {
    tessar.hook(model.end, event => {
      console.log(event.payload.attemptId, event.payload.response.usage);
    });
    tessar.hook(tool.before, event => {
      if (event.payload.tool.name === "delete_file") {
        return { decision: "deny", reason: "Deletion disabled" };
      }
    });
  }
}

// agent là Agent đã được ứng dụng cấu hình.
// const controller = new Controller({ id: "app", agent, plugins: [new ObservePlugin()] });
// await controller.initialize();
// Dùng agent.stream/generate hoặc tạo Session theo nhu cầu.
// await controller.dispose();

// Entry point cho plugin được PluginManager load sau khi app đã đóng gói:
export default new ObservePlugin();
```

```ts
interface Plugin {
  readonly id: string;
  readonly version?: number;
  readonly configurationId?: string;
  setup(tessar: PluginContext): void | Disposer | Promise<void | Disposer>;
}
type Disposer = () => void | Promise<void>;
```

`version` và `configurationId` nhận diện contract/code/configuration khi kiểm tra
continuation. Chúng khác version của package npm. Trùng plugin ID đang attach bị
từ chối. Setup thất bại rollback registrations và chạy cleanup đã đăng ký.

## 2. PluginContext: API ở bước setup

`tessar` là tên biến nhận `PluginContext`, không phải global singleton.
Các method bên dưới thuộc cùng instance context truyền vào `setup()`.

| API | Parameter | Return | Trách nhiệm |
| --- | --- | --- | --- |
| `tessar.hook(name, handler, options?)` | `name: D extends AnyEvent`, `handler: EventHandler<D>`, `options?: { kind?: EventKind; version?: number }` | `Disposer` | Đăng ký handler; gọi disposer để bỏ handler đó |
| `tessar.emit(name, payload)` | `name: D`, `payload: PayloadOf<D>` | `Promise<ResultOf<D>>` | Dispatch hook theo contract; không tự gửi message tới model |
| `tessar.defer(disposer)` | `() => void \| Promise<void>` | `void` | Cleanup khi plugin được giải phóng; disposer chạy theo thứ tự ngược đăng ký |
| `tessar.tools.register(tool)` | `Tool` tạo bằng `createTool()` hoặc `new Tool()` | `void` | Đăng ký tool theo `tool.name`, giữ schema identity cho resume |
| `tessar.models.register(provider)` | `ModelProviderRegistration` | `void` | Đăng ký provider factory và metadata |
| `tessar.storage.register(backend)` | `StorageBackend` | `void` | Chọn storage backend; chỉ trước khi storage được chốt lúc initialize |
| `tessar.storage.records.append(options)` | `{ namespace, data, id?, scope? }` | `Promise<StoredRecord>` | Thêm record độc lập trên backend đã chọn, không ghi vào checkpoint |
| `tessar.storage.records.get(namespace, id, query?)` | Hai string; `{ scope? }` tùy chọn | `Promise<StoredRecord \| null>` | Đọc một record đúng namespace/ID và scope |
| `tessar.storage.records.list(query)` | `{ namespace, scope?, limit?, cursor? }` | `Promise<Page<StoredRecord>>` | Đọc phân trang; mặc định 50, tối đa 200, tăng dần theo createdAt/ID |
| `tessar.agent.register(agent)` | `Agent` | `void` | Đăng ký Agent độc lập; host đăng ký `agent.shutdown()` khi plugin được giải phóng |
| `tessar.state.define(definition)` | `Omit<PluginStateDefinition<T>, "pluginId">`, `T extends JsonValue` | `PluginStateDefinition<T>` | Đăng ký namespace; `pluginId` lấy từ plugin hiện tại |
| `tessar.effects.register(definition)` | `EffectDefinition` | `void` | Đăng ký external effect có contract phục hồi |
| `tessar.interruptions.register(definition)` | `InterruptionDefinition` | `void` | Đăng ký câu hỏi/approval tại decision boundary |
| `tessar.registry.register(kind, id, value, version?)` | `kind: string`, `id: string`, `value: unknown`, `version?: number` | `void` | Chia sẻ capability do plugin tự định nghĩa; version mặc định 1 |

Capability trùng `(kind, id)` bị từ chối. Đăng ký thêm Agent không tự tạo delegate
tool, process, quan hệ cha/con hay chính sách subagent. Plugin tự kết hợp các API
cần thiết. Storage được đăng ký sẽ được đóng theo lifecycle plugin; lỗi driver
giữ exception gốc và được gắn nguồn `storage` tại boundary của host.

Handler có chữ ký:

```ts
type EventHandler<D extends AnyEvent> = (
  event: EventEnvelope<PayloadOf<D>, D>,
  context: ContextOf<D>,
) => ResultOf<D> | void | Promise<ResultOf<D> | void>;
```

`tessar.emit()` dùng dispatcher ở cấp plugin/host. Khi đang trong execution,
dùng `context.events.emit()` cho custom notification cần mang identity của lượt
đang chạy và đi qua Stream/subscription. Hai method không thay thế cho
`session.followUp()` hoặc `agent.sendSignal()`.

## 3. Envelope và thời gian

Mọi handler nhận `event.type`, `event.payload` và các field identity/context:

| Field | Type | Ý nghĩa |
| --- | --- | --- |
| `timestamp` | `string` | Thời điểm phát event, được Tessar cấp một lần |
| `controllerId`, `agentId`, `sessionId`, `threadId` | `string?` | Identity khi boundary có đối tượng tương ứng |
| `streamId` | `string \| null \| undefined` | Logical Stream ID, không phải ID một lần gọi model |
| `handleId` | `string?` | Identity của attachment/delivery khi có |
| `scope` | `JsonObject?` | Scope dữ liệu của operation/execution |
| `sequence` | `number?` | Thứ tự trong phạm vi publisher; không phải global sequence |
| `checkpointRevision` | `number?` | Revision khi publisher cung cấp |

Đọc identity từ envelope; không giả định mọi event đều có Session hoặc Thread.
Ví dụ `ready` không cần một cuộc hội thoại, còn Agent chạy trực tiếp không có
Session. Dùng `event.type === model.end` để narrow payload.

Lifecycle payload có `startedAt` và `endedAt` lấy từ **record của tác vụ**:

```text
tool.start.payload = { ..., startedAt: "2026-10-25T10:00:00.000Z" }
tool.end.payload   = { ..., startedAt: "2026-10-25T10:00:00.000Z",
                           endedAt: "2026-10-25T10:00:02.000Z" }
tool.end.timestamp = "2026-10-25T10:00:02.050Z"
```

`startedAt` ở event kết thúc lặp lại cùng mốc từ record, giúp consumer chỉ nghe
end vẫn nhận đủ hai mốc. `timestamp` có thể muộn hơn do commit hoặc ordered
publication. Field optional/nullable phản ánh boundary chưa có record hoặc
legacy/recovery data; không tự tạo số liệu khi thiếu. Phép trừ hai wall-clock
mốc không thay thế active `durationMs` của record, nhất là qua suspension.

## 4. Bốn loại hook

| Kind | Return của handler | Khi throw/reject |
| --- | --- | --- |
| `notification` | `void`; return không điều khiển execution | Gửi diagnostics, không làm policy thất bại chỉ vì observer lỗi |
| `transformation` | Payload thay thế hoặc `undefined` để giữ nguyên | Lỗi được truyền về caller; boundary có thể dừng execution/operation |
| `decision` | Quyết định đúng với boundary hoặc `undefined` | Lỗi được truyền về caller |
| `barrier` | `void`; caller chờ handler hoàn tất | Lỗi truyền về caller; shutdown có cleanup/error handling riêng |

Handlers chạy theo thứ tự đăng ký. Transformation sau nhận payload đã được
transformation trước thay thế. Decision đã `deny`/`stop` không được handler sau
đổi thành allow/continue. Không suy ra rằng mọi member của `ControlDecision`
đều có tác dụng ở mọi decision hook; xem mục 6.

Notification thường được dispatcher await nhưng không có mutable execution
services; turn.start có state context L để cập nhật state lifecycle. Riêng publisher như `state_changed`/Session notification có thể dispatch
bất đồng bộ. `session.subscribe()` là quan sát UI, không phải policy hook và
không chờ callback để điều khiển loop.

## 5. Toàn bộ event built-in

Map import từ `@tessar/core`, không có prefix `events` hay `core`. Event vẫn là
string. Ví dụ `thread.beforeDelete` là `"thread.before-delete"`; các segment có
dấu gạch dùng camelCase ở map. Trong cột đầu, string chỉ ghi thêm khi khác map.

Context viết tắt trong bảng:

- **H**: `HookContext`: registry đọc; Session/Thread/signal optional theo publisher.
- **E**: `ExecutionHookContext`: H + state, signal, threadId, streamId và tracked services.
- **D**: `DecisionHookContext`: E + `suspend(definition, payload)`.
- **S**: `SessionHookContext`: H + `session` bắt buộc.
- **L**: `StateHookContext`: H + plugin state, chỉ tại turn.start; không có execution control services.
- **T**: `ThreadHookContext`: H + `thread` bắt buộc.

`void` ở cột Return nghĩa là notification/barrier không có kết quả điều khiển.
Type được tham chiếu như `ModelRequest`, `ThreadInfo` là type public trong core.

60 event built-in hiện tại:

### Framework và UI

| Map (string nếu khác) | Kind | event.payload | Return / context | Dùng khi nào |
| --- | --- | --- | --- | --- |
| `ready` | notification | `{ agentId: string; }` | `void` / H | Khởi động kết nối hoặc dịch vụ của plugin sau khi Controller ready; không phải báo mỗi lần model sẵn sàng. |
| `shutdown` | barrier | `{}` | `void` / H | Chờ tác vụ cần hoàn tất trước khi Controller đóng; cleanup tài nguyên riêng dùng defer. |
| `diagnostic` | notification | `{ error: ErrorInfo; }` | `void` / H | Thu lỗi từ observer, plugin hoặc runtime để ghi log/cảnh báo; không dùng quyết định retry. |
| `stateChanged`<br>`"state_changed"` | notification | `{ state: RuntimeState; }` | `void` / H | Render lại UI từ snapshot mới, gồm nội dung đang stream, tool, interrupt và queue. |

### Session

| Map (string nếu khác) | Kind | event.payload | Return / context | Dùng khi nào |
| --- | --- | --- | --- | --- |
| `session.created` | notification | `{ model: ModelRef; }` | `void` / S | Theo dõi một Session mới, ví dụ ghi audit hoặc cập nhật danh sách phiên. |
| `session.modelChanged`<br>`"session.model-changed"` | notification | `{ previous: ModelRef; model: ModelRef; previousOptions?: JsonObject; options?: JsonObject; }` | `void` / S | Cập nhật UI/audit khi model hoặc connection được chọn đã đổi; options có event riêng. |
| `session.model.optionsChanged`<br>`"session.model.options-changed"` | notification | `{ model: ModelRef; previousOptions?: JsonObject; options?: JsonObject; }` | `void` / S | Cập nhật UI/audit sau khi options được lưu; đọc previousOptions/options hoặc model.info(). |
| `session.threadSwitched`<br>`"session.thread-switched"` | notification | `{ previousThreadId: string \| null; threadId: string; }` | `void` / S | Đổi tiêu đề, tab hoặc dữ liệu phụ khi Session chọn Thread khác. |
| `session.inputQueued`<br>`"session.input-queued"` | notification | `{ receipt: QueuedInputReceipt; }` | `void` / S | Hiển thị input followUp đang đợi; không coi là input đã gửi model. |
| `session.inputDiscarded`<br>`"session.input-discarded"` | notification | `{ receipt: QueuedInputReceipt; cause: string; }` | `void` / S | Báo input đang đợi bị bỏ và nguyên nhân. |
| `session.closed` | notification | `{}` | `void` / S | Ngừng quan sát và cập nhật UI khi Session đã đóng. |
| `session.model.beforeChange`<br>`"session.model.before-change"` | decision | `{ previous: ModelRef; model: ModelRef; previousOptions?: JsonObject; options?: JsonObject; }` | `OperationDecision` / S | Cho phép/từ chối người dùng đổi model hoặc options theo policy ứng dụng. |
| `session.thread.beforeSwitch`<br>`"session.thread.before-switch"` | decision | `{ previousThreadId: string \| null; threadId: string; }` | `OperationDecision` / S | Cho phép/từ chối Session chuyển sang Thread được yêu cầu. |

### Thread

| Map (string nếu khác) | Kind | event.payload | Return / context | Dùng khi nào |
| --- | --- | --- | --- | --- |
| `thread.prepare` | transformation | `CreateThreadOptions` | `CreateThreadOptions` / H | Bổ sung dữ liệu khởi tạo mặc định, ví dụ metadata hoặc tin nhắn mở đầu; giữ scope và ID đã cấp. |
| `thread.started` | notification | `ThreadInfo` | `void` / H | Ghi audit hoặc liên kết tài nguyên khi Thread được tạo; không phải mỗi lần resume hoặc gọi model. |
| `thread.beforeFork`<br>`"thread.before-fork"` | decision | `{ threadId: string; options: ForkOptions; }` | `OperationDecision` / T | Kiểm tra policy trước khi tạo nhánh lịch sử. |
| `thread.forked` | notification | `{ threadId: string; forkedThreadId: string; }` | `void` / T | Liên kết nhánh mới hoặc ghi audit quan hệ fork ở tầng Thread. |
| `thread.beforeRename`<br>`"thread.before-rename"` | decision | `{ threadId: string; title: string; }` | `OperationDecision` / T | Kiểm tra quyền/quy tắc đặt tên trước khi đổi tiêu đề. |
| `thread.renamed` | notification | `{ threadId: string; title: string; }` | `void` / T | Đồng bộ index hoặc ghi audit sau khi Thread đổi tên. |
| `thread.beforeDelete`<br>`"thread.before-delete"` | decision | `{ threadId: string; permanent?: boolean; }` | `OperationDecision` / T | Kiểm tra policy trước khi xóa mềm hoặc purge vĩnh viễn. |
| `thread.deleted` | notification | `{ threadId: string; permanent?: boolean; }` | `void` / T | Dọn tham chiếu bên ngoài hoặc ghi audit sau khi thao tác xóa thành công. |

### Input và Stream

| Map (string nếu khác) | Kind | event.payload | Return / context | Dùng khi nào |
| --- | --- | --- | --- | --- |
| `input.prepare` | transformation | `InputPreparation` | `InputPreparation` / E | Biến đổi input mới, xử lý slash command, trả câu trả lời trực tiếp hoặc từ chối trước loop. |
| `input.received` | notification | `{ messages: readonly MessageData[]; }` | `void` / H | Ghi nhận input đã được nhận sau chuẩn bị; không sửa input hoặc history. |
| `stream.before` | decision | `{ input: readonly MessageData[]; }` | `StreamDecision` / D | Cho phép, dừng hoặc yêu cầu xác nhận trước khi bắt đầu loop của lượt này. |
| `stream.started` | notification | `{ modelRef: ModelRef; checkpointId: string; startedAt?: string; }` | `void` / H | Mở log/trace cho lượt chạy và nhận identity của Stream. |
| `stream.end` | notification | `StreamOutcome` | `void` / H | Đọc status/output/usage cuối của lượt để kết thúc tác vụ UI hoặc log/trace. |
| `stream.error` | notification | `{ target?: "execution" \| "consumer"; error: ErrorInfo; lastKnownCheckpointId: string \| null; persistedStatus: string \| null; startedAt?: string; endedAt?: string \| null; }` | `void` / H | Báo lỗi execution hoặc consumer; đọc target để phân biệt phạm vi lỗi. |
| `stream.suspended` | notification | `{ checkpointId: string; interrupt: InterruptRecord; }` | `void` / H | Hiển thị câu hỏi/approval từ interrupt và chờ ứng dụng cung cấp câu trả lời. |
| `stream.resumed` | notification | `{ checkpointId: string; interruptId: string \| null; reason: string; }` | `void` / H | Tiếp tục hiển thị/theo dõi một Stream được resume hoặc recovery, theo payload.reason. |
| `stream.cancel` | notification | `{ reason: string; }` | `void` / H | Ghi nhận yêu cầu/hành động hủy; trạng thái kết thúc vẫn đọc từ stream.end hoặc lỗi. |

### Turn và context

| Map (string nếu khác) | Kind | event.payload | Return / context | Dùng khi nào |
| --- | --- | --- | --- | --- |
| `turn.start` | notification | `{ turnId: string; index: number; startedAt?: string; }` | `void` / L | Quan sát Turn mới và cập nhật plugin state tại lifecycle boundary; không chọn model. |
| `turn.end` | notification | `{ turnId: string; usage: UsageSummary; startedAt?: string; endedAt?: string \| null; }` | `void` / H | Chốt số liệu và thời gian của Turn; chưa chắc toàn bộ Stream đã kết thúc. |
| `turn.decision` | decision | `{ turnId: string; hadTools: boolean; }` | `TurnDecision` / D | Dừng loop hoặc yêu cầu thêm Turn sau bước vừa hoàn tất. |
| `context.prepare` | transformation | `ModelRequest` | `ModelRequest` / E | Dựng instruction, thêm skill/memory, chọn history hoặc thay bằng summary cho primary model. |

### Model và provider

| Map (string nếu khác) | Kind | event.payload | Return / context | Dùng khi nào |
| --- | --- | --- | --- | --- |
| `model.select` | decision | `{ model: ModelRef; }` | `ModelSelectionDecision` / D | Chọn ModelRef cho lần gọi primary model tiếp theo; không thay model bằng sửa request.model. |
| `provider.request` | transformation | `ProviderRequest` | `ProviderRequest` / E | Đọc/sửa body riêng của provider sau adapter encode, trước SDK. Không đổi identity, model hoặc streaming; không gồm headers. |
| `model.start` | notification | `{ attemptId: string; startedAt?: string; model: ModelRef; request?: ModelRequest; purpose?: "primary" \| "auxiliary"; turnId?: string; parentToolExecutionId?: string \| null; }` | `void` / H | Đọc context chuẩn hóa của attempt để ghi trace input/model và thời điểm bắt đầu; không phải native body sau provider.request. |
| `model.end` | notification | `{ attemptId: string; response: ModelResponse; purpose?: "primary" \| "auxiliary"; startedAt?: string; endedAt?: string \| null; }` | `void` / H | Đọc response cuối, usage và thời gian của một attempt thành công; không có nghĩa hết Stream. |
| `model.response` | transformation | `ModelResponse` | `ModelResponse` / E | Biến đổi response primary trước khi runtime tạo các tool execution và lưu assistant message. |
| `model.usage` | notification | `{ attemptId: string; usage: ModelUsage; purpose?: "primary" \| "auxiliary"; }` | `void` / H | Theo dõi usage do provider phát trong lúc gọi; dữ liệu cuối có thể chỉ nằm ở model.end. |
| `model.error` | notification | `{ attemptId: string; error: ErrorInfo; purpose?: "primary" \| "auxiliary"; startedAt?: string; endedAt?: string \| null; }` | `void` / H | Ghi lỗi của một attempt; không tự retry chỉ vì handler nghe event này. |
| `model.recover` | decision | `{ attemptId: string; error: ErrorInfo; }` | `ModelRecoveryDecision` / D | Quyết định thử lại primary model sau lỗi hoặc suspend để chờ xử lý; vẫn chịu limits. |

### Message và streaming part

| Map (string nếu khác) | Kind | event.payload | Return / context | Dùng khi nào |
| --- | --- | --- | --- | --- |
| `message.prepare` | transformation | `MessageData` | `MessageData` / E | Áp dụng quy tắc chung cho message đi qua pipeline, ví dụ thêm metadata; giữ identity/role/correlation. |
| `text.start` | notification | `PartEvent<"text.start">` | `void` / H | Quan sát bắt đầu sinh part; chưa phải thực thi tool. |
| `text.delta` | notification | `PartEvent<"text.delta">` | `void` / H | Đọc text/thinking tăng dần; UI có thể dùng state_changed thay việc tự ghép. |
| `text.end` | notification | `PartEvent<"text.end">` | `void` / H | Quan sát part hoàn tất hoặc bị ngắt; tool arguments chỉ có khi completed. |
| `reasoning.start` | notification | `PartEvent<"reasoning.start">` | `void` / H | Quan sát bắt đầu sinh part; chưa phải thực thi tool. |
| `reasoning.delta` | notification | `PartEvent<"reasoning.delta">` | `void` / H | Đọc text/thinking tăng dần; UI có thể dùng state_changed thay việc tự ghép. |
| `reasoning.end` | notification | `PartEvent<"reasoning.end">` | `void` / H | Quan sát part hoàn tất hoặc bị ngắt; tool arguments chỉ có khi completed. |
| `tool.call.start` | notification | `PartEvent<"tool.call.start">` | `void` / H | Quan sát bắt đầu sinh part; chưa phải thực thi tool. |
| `tool.call.end` | notification | `PartEvent<"tool.call.end">` | `void` / H | Quan sát part hoàn tất hoặc bị ngắt; tool arguments chỉ có khi completed. |
| `message.committed` | notification | `{ message: MessageData; checkpointId: string; }` | `void` / H | Theo dõi message đã lưu bền vững hoặc đồng bộ index bên ngoài theo checkpoint. |

### Tool execution và checkpoint

| Map (string nếu khác) | Kind | event.payload | Return / context | Dùng khi nào |
| --- | --- | --- | --- | --- |
| `tool.prepare` | transformation | `ToolPreparation` | `ToolPreparation` / E | Biến đổi arguments trước khi kiểm tra policy và thực thi tool; không thay Tool implementation bằng sửa field tool. |
| `tool.before` | decision | `ToolPreparation` | `ToolDecision` / D | Cho phép/từ chối hoặc suspend xin approval cho một tool call cụ thể. |
| `tool.start` | notification | `{ toolExecutionId: string; startedAt?: string \| null; toolCallId: string; turnId?: string; name?: string; arguments?: JsonObject; }` | `void` / H | Mở log/span cho tool thực sự bắt đầu, kèm arguments và execution ID. |
| `tool.update` | notification | `{ toolExecutionId: string; progress: JsonValue; }` | `void` / H | Hiển thị tiến độ do chính tool chủ động emit, ví dụ số file đã xử lý. |
| `tool.end` | notification | `{ toolExecutionId: string; toolCallId: string; result: MessageData; status: string; startedAt?: string \| null; endedAt?: string \| null; }` | `void` / H | Đọc kết quả và status tool khi runtime publish result; chốt log/span theo toolExecutionId. |
| `tool.error` | notification | `{ toolExecutionId: string; error: ErrorInfo; startedAt?: string \| null; endedAt?: string \| null; }` | `void` / H | Ghi nhận lỗi tool; runtime vẫn có thể tạo ToolMessage báo lỗi cho model. |
| `tool.result` | transformation | `MessageData` | `MessageData` / E | Biến đổi ToolMessage, ví dụ rút gọn output trước khi đi tiếp qua message pipeline. |
| `checkpoint.committed` | notification | `{ checkpointId: string; revision: number; }` | `void` / H | Biết checkpoint đã commit để đọc/đồng bộ dữ liệu; không đồng nghĩa có một message mới. |

Streaming payload dùng chung messageId/partId/partIndex, attemptId/purpose/parentToolExecutionId. Start có startedAt và boundary; delta có delta; end có startedAt/endedAt, status completed/interrupted, boundary và text hoặc tool identity/arguments hoàn chỉnh. Interrupted tool-call không có arguments. Không có tool.call.delta.

## 6. Quyết định và suspension

| Boundary | Quyết định loop/operation sử dụng |
| --- | --- |
| `stream.before` | `deny`/`stop` dừng lượt; `undefined` cho đi tiếp |
| `model.select` | `{ decision: "select", model: ModelRef }` chọn model |
| `model.recover` | `retry` tạo lần thử tiếp theo trong limits; không retry thì lỗi được truyền tiếp |
| `tool.before` | `allow`, `deny` hoặc `stop`; deny tạo tool result bị từ chối, stop dừng execution |
| `turn.decision` | `stop`/`deny` dừng; `continue` yêu cầu thêm Turn kể cả khi không có tool |
| `session.model.beforeChange`, `session.thread.beforeSwitch`, `thread.beforeFork/beforeRename/beforeDelete` | Chỉ `allow`, `deny` hoặc `undefined`; deny trả `OperationDenied`; không suspend |

Execution decision boundaries trong năm dòng đầu hỗ trợ registered interruption
qua `context.suspend()`. Không gọi method này trong notification, transformation
hoặc operation decision chỉ có H/S/T context.

```ts
interface InterruptionDefinition<R, D extends ResolvedDecision, P extends JsonValue> {
  readonly id: string;
  readonly version: number;
  readonly response: InputDefinition<R>;
  readonly payload?: InputDefinition<P>;
  readonly resolve: (response: R, payload: P) => D;
}
// defineInterruption(definition) trả lại typed definition đã được validate/freeze.
// tessar.interruptions.register(definition) đăng ký trong setup.
// return context.suspend(definition, payload) từ execution decision hook.
```

`InputDefinition<T>` có `{ jsonSchema: JsonObject; parse(value: unknown): T }`.
`resolve()` cần deterministic vì quyết định được phục hồi từ response đã lưu.
Host render `stream.suspended.payload.interrupt`, rồi gọi:

```ts
// Agent trực tiếp: trả Stream mới cho continuation.
// agent.resume({ threadId, interruptId, value, scope?, signal? });
// Session: nhận receipt, các event sau tiếp tục qua subscription.
// await session.resume({ interruptId, value, model? });
```

Helpers public: `ToolDecision.allow()`, `ToolDecision.deny(reason)`,
`TurnDecision.continue()`, `TurnDecision.stop(reason)`,
`InputDecision.continue(messages)`, `InputDecision.handled({ output })`,
`InputDecision.reject(error)`. Ba InputDecision helpers trả `InputPreparation`
cho `input.prepare`, không trả `ControlDecision`.

## 7. API trong context của hook

### Registry đọc và handles

| API | Return / ghi chú |
| --- | --- |
| `context.registry.get<T>(kind, id)` | `T \| undefined` |
| `context.registry.list<T>(kind)` | `readonly T[]` |
| `context.session` | Optional ở H/E/D, bắt buộc ở S; handle giới hạn bên dưới |
| `context.thread` | Optional ở H/E/D, bắt buộc ở T; handle đọc giới hạn bên dưới |
| `context.signal` | `AbortSignal` bắt buộc ở E/D; optional ở H/S/T |

Registry đọc là tập capabilities của dispatch hiện tại. Setup chỉ có
`tessar.registry.register`; thao tác đọc nằm ở handler context.
Với capability tự định nghĩa, consumer và producer thống nhất `kind/id/type`.
Generic `<T>` là type assertion của caller, không phải runtime validation.

`SessionHookHandle` cho `id`, `scope()`, `model`, `thread`, `followUp`,
`state.get()`, `isIdle()`, `isDisposed()`. Không expose `abort`, `dispose`,
`resume`, `recover`, `subscribe` trên handle này.

| Nhóm Session handle | Parameter → return |
| --- | --- |
| `model.get()` / `name()` | `string` full ID / native model name |
| `model.info()` | Snapshot `{ id, name, profile, options? }` hiện tại |
| `model.setEffort(level)` | `string` → `Promise<void>`; mapping thuộc provider |
| `model.list()` | `readonly SessionModelInfo[]` với `id/name/profile` |
| `model.switch(modelId, options?)` | `string`, `JsonObject?` → `Promise<void>` |
| `thread.create(options?)` | `SessionThreadOptions?` → `Promise<Thread>` |
| `thread.switch(id)` / `get(id)` | `string` → `Promise<Thread>` / `Promise<Thread \| null>` |
| `thread.getId()` | `string \| null` của Thread đang chọn |
| `thread.list(options?)` | `PageOptions?` → `Promise<Page<ThreadInfo>>` |
| `thread.rename(title, target?)` | `string`, `{ threadId?: string }?` → `Promise<void>` |
| `thread.fork(options?)` | `(ForkOptions & { threadId?: string })?` → `Promise<Thread>` |
| `thread.delete(target?)` / `purge(target?)` | `{ threadId?: string }?` → `Promise<void>`; purge xóa vĩnh viễn |
| `thread.getHistory(options?)` | `(HistoryOptions & { threadId?: string })?` → `Promise<HistoryPage>` |
| `followUp(input)` | `string \| MessageData \| readonly MessageData[]` → `Promise<QueuedInputReceipt>` |
| `followUp.count()` / `isEmpty()` | Số input đang chờ / boolean |
| `state.get()` / `isIdle()` / `isDisposed()` | Snapshot / boolean / boolean |

Các method control vẫn có busy/lifecycle/policy checks. Có handle trong hook không
có nghĩa đổi Thread/model trong lúc đang chạy luôn được phép. `followUp()` chấp
nhận input xếp hàng, không đợi model trả lời; đừng tạo callback chờ chính lượt
hiện tại hoàn tất rồi await callback đó từ trong hook của lượt ấy.

`ThreadHookHandle` cho `id`, `scope()`, `snapshot()`, `getHistory(options?)`,
`getCheckpoint(id)`, `listCheckpoints(options?)`, `listInterrupts(options?)`.
Snapshot/history/checkpoint đều là async reads; handle không chứa method chạy
Agent, dispose hoặc list toàn bộ execution records. Xem parameter paging/history
tại [API reference](api-review.md).

### State của plugin — E/D và lifecycle L

```ts
interface PluginStateDefinition<T extends JsonValue> {
  pluginId: string;
  namespace: string;
  schemaVersion: number;
  initial: T;
  migrate?: (value: JsonValue, fromVersion: number) => T;
  fork?: "copy" | "reset" | ((value: T, context: {
    sourceThreadId: string; targetThreadId: string;
  }) => T);
}
```

| API | Parameter → return |
| --- | --- |
| `context.state.get(definition)` | `PluginStateDefinition<T>` → `T` immutable snapshot |
| `context.state.update(definition, value)` | `T \| ((previous: T) => T)` → `void` |
| `context.state.commit()` | Không parameter → `Promise<string>` checkpoint ID |
| `context.state.withOwner(owner)` | `{ type: "thread" \| "stream" \| "turn"; id: string }` → cùng API state với owner khác |
| `context.state.owned(owner)` | `{ type: "agent" \| "session"; id: string }` → explicit CAS access |
| `owned.read(definition)` | → `Promise<{ value: T; revision: number; schemaVersion: number }>` |
| `owned.update(definition, expectedRevision, value)` | → `Promise<{ value: T; revision: number }>`; conflict bị từ chối |

Default owner của execution hook là Thread. Thread/Stream/Turn state tham gia
checkpoint; agent/session-owned CAS commit riêng và không atomic với checkpoint,
không rewind theo Thread fork. `update()` không phải một lần ghi DB ngay lập tức.
`definePluginState()` public chỉ tạo definition; vẫn cần đăng ký definition để
execution sử dụng. Constructor của state access không phải API cần tự khởi tạo.

```ts
// Bên trong setup(tessar):
// const stats = tessar.state.define({ namespace: "stats", schemaVersion: 1,
//   initial: { prepared: 0 }, fork: "reset" });
// tessar.hook(context.prepare, (event, ctx) => {
//   ctx.state.update(stats, previous => ({ prepared: previous.prepared + 1 }));
//   return event.payload;
// });
```

### Tracked services — E/D và ToolExecutionContext

| API | Parameter | Return |
| --- | --- | --- |
| `context.models.stream(request)` | `ModelRequest` | `AsyncIterable<ModelChunk>` |
| `context.effects.execute(definition, input, options)` | `EffectDefinition<I,O>`, `I`, `{ key: string }` | `Promise<O>` |
| `context.events.emit(name, payload)` | `D extends AnyEvent`, `PayloadOf<D>`; chỉ notification | `Promise<void>` |

Tracked model/effect yêu cầu execution đã admitted; auxiliary model cần active
Turn và tính vào model-attempt budget. Không phải mọi E/D boundary đều đã đủ
điều kiện này. Gọi auxiliary không tự thay toàn bộ policy của primary model loop.

```ts
interface EffectDefinition<I, O> {
  id: string;
  version: number;
  input: InputDefinition<I>;
  output: InputDefinition<O>;
  execute(input: I, context: EffectContext): Promise<O>;
  reconcile?(operation: { input: I; key: string; id: string }): Promise<
    { status: "completed"; output: O }
    | { status: "safeToRetry" }
    | { status: "unknown" }
  >;
}
```

`defineEffect()` validate/freeze definition; đăng ký bằng `tessar.effects.register()`.
EffectContext có `signal`, `threadId`, `streamId`, `turnId: string | null`,
`toolExecutionId?`, `operationId`, `key`. Key nhận diện operation; kết quả đã
commit được dùng lại. Outcome chưa biết cần reconcile, không mặc định replay
external I/O và không bảo đảm mọi callback tùy ý là exactly-once.

## 8. Tool API dùng khi viết plugin

`createTool()` import từ `@tessar/core/tool` hoặc root. Plugin đăng ký Tool trực
tiếp; ứng dụng cũng có thể đưa Tool vào `Agent.tools` mà không bọc plugin.

```ts
createTool({
  name: string,
  description: string,
  schema: z.ZodType<I>,
  execute(input: I, context: ToolExecutionContext): ToolResult | Promise<ToolResult>,
  resumeSchema?: z.ZodType<R>,
  resume?(response: R, input: I, context: ToolExecutionContext): ToolResult | Promise<ToolResult>,
  recovery?: ToolRecovery<I>,
});
```

Đây là sơ đồ type cho các parameter, không phải object JavaScript để copy chạy.
`ToolResult` là JSON, `ToolMessage` hoặc `ToolSuspension`; `createTool().execute`
normalize kết quả thông thường thành `ToolMessage`, runtime gắn toolCallId.

ToolExecutionContext có `signal`, `threadId`, `streamId`, `turnId`,
`toolExecutionId`, cùng ba tracked services ở trên, thêm:

- `emit(progress: JsonValue): void` phát `tool.update`.
- `suspend(payload: JsonValue): ToolSuspension`: phải **return** kết quả này;
  host nhận interrupt rồi resume bằng Agent/Session API.

`context.suspend()` trong tool khác decision-context suspend: tool không cần tự
đăng ký InterruptionDefinition. `resumeSchema` validate câu trả lời; `resume()`
xử lý câu trả lời đó. ToolRecovery có `idempotencyKey(input, { toolExecutionId })`
và `reconcile({ id, input, key })`, trả completed/result, safeToRetry hoặc unknown.
Xem ví dụ chạy thật trong [tool guide](../examples/guide/tools.md).

Provider đăng ký qua `tessar.models.register()` có `id`,
`create(modelId): ModelAdapter`, optional `metadata`, `endpoint`,
`metadataPartition`, `catalogModelRef(ref)` và `catalogMappingVersion`.
Provider adapter chịu trách nhiệm protocol/native options; Tool/Message của
Tessar không yêu cầu plugin tự tạo payload theo từng provider.

## 9. Attach/detach và PluginManager

| API phía ứng dụng | Parameter → return |
| --- | --- |
| `new Controller({ id, agent, plugins? })` | `plugins?: readonly Plugin[]` chứa instances đã có sẵn |
| `controller.initialize()` | → `Promise<void>`; chạy setup và đưa Controller tới ready |
| `controller.plugins.attach(plugin)` | `Plugin` → `Promise<void>`; Controller phải ready |
| `controller.plugins.detach(id)` | Plugin ID `string` → `Promise<void>` |
| `controller.dispose()` | → `Promise<void>`; đóng Session, Agent và plugin resources |
| `new PluginManager(options)` | `{ directory: string; hostUrl?: string }`, từ `@tessar/plugins` |
| `manager.discover()` | → `Promise<string[]>` |
| `manager.load(sources?)` | `readonly string[]?` → `Promise<Plugin[]>`; không tự attach/setup |
| `manager.install(source, options?)` | `string`, `{ name?: string }?` → `Promise<string>` tên package |
| `manager.update(name?)` | `string?` → `Promise<void>` |
| `manager.remove(name)` | `string` → `Promise<void>` |
| `manager.dispose()` | → `void`; bỏ Node module resolver hooks sau runtime shutdown |

`plugins: []` không nhận path/load descriptor. Muốn load từ filesystem/npm thì
ứng dụng thêm PluginManager, gọi load rồi truyền instances vào Controller hoặc
attach từng instance khi Controller ready. Plugin có sẵn không cần Manager.
Detach ngăn execution mới dùng plugin; execution đã capture giữ tài nguyên tới
khi release. Storage plugin không được detach lúc Controller ready.

```ts
import { resolve } from "node:path";
import { PluginManager } from "@tessar/plugins";

// Bên trong host đã có agent:
// const manager = new PluginManager({ directory: resolve(".my-cli"), hostUrl: import.meta.url });
// let controller: Controller | undefined;
// try {
//   const plugins = await manager.load();
//   controller = new Controller({ id: "app", agent, plugins });
//   await controller.initialize();
//   // Chạy Agent/Session của ứng dụng.
// } finally {
//   try { await controller?.dispose(); }
//   finally { manager.dispose(); }
// }
```

Trong directory do host chọn: `plugins/` chứa custom entrypoints,
`plugins.json` có `{ packages?: string[] }`, `npm/` giữ npm manifest/lockfile và
node_modules cho các package đã install. Constructor/load không tự tạo toàn bộ
layout hoặc install dependency thiếu. Module default-export Plugin instance;
loader không tự `new` class. Xem [distribution guide](plugin-authoring.md#distribution).

## 10. Custom event và các nguyên tắc sử dụng

Plugin có thể augment `EventMap` bằng `HookSpec<Payload, Result, Context>` để
TypeScript nhận event riêng. Custom event mặc định là notification; khai báo
`tessar.hook(name, handler, { kind, version })` khi cần contract khác. Trùng tên
nhưng khác kind/version bị từ chối. Type augmentation không tự thêm event vào loop:
plugin/ứng dụng phải chủ động emit tại nơi phù hợp.

Phân biệt ba version: npm package version cho phân phối; Plugin.version và
configurationId cho compatibility; state schemaVersion/interruption/effect/hook
version cho contract dữ liệu hoặc boundary tương ứng.

Instruction section ordering thuộc `buildInstruction()` và field `order`,
không phải ưu tiên đăng ký hook. Plugin sửa prepared model context không mặc định
sửa lịch sử đã lưu. Metadata của message/part là dữ liệu của ứng dụng; không tự
gửi tới provider. Các capability như memory, skill, compaction, sandbox, scheduler
hay delegate do plugin tự kết hợp từ hooks/state/tools/Agent theo nhu cầu.

## 11. Ranh giới cần phân biệt

- context.prepare sửa context và tập tool được quảng bá; tool.before vẫn kiểm tra quyền thực thi.
- provider.request sửa body đã encode, không đổi credentials/model/streaming. Model phụ dùng cùng provider boundary nhưng không tự chạy context.prepare của loop cha.
- tool.call là sinh lời gọi; tool.start/update/end/error là thực thi. Không có argument delta công khai.
- text/reasoning/tool.call là quan sát; state_changed là snapshot UI đã tổng hợp. Part status chỉ ở RAM, không gửi model hoặc lưu DB.
- Thread mutation phát một notification sau cập nhật Session. checkpoint.committed là mốc durable commit.
- Decision theo boundary; không trả một ControlDecision bất kỳ. Giá trị không hợp lệ bị từ chối và invalid resume giữ interrupt pending.
- State-operation policy gate vẫn có quyền allow/deny. Cleanup tài nguyên dùng defer/dispose; notification cuối không veto kết quả đã commit.
