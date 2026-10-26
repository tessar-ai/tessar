# Tessar — Event hooks và Plugin API

Đối chiếu code và public declarations trong checkout ngày **2026-10-26**.
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
| Render chat đang chạy, gồm text/thinking/tool/status | `state_changed`, đọc `event.payload.state` | `message.delta` khi tự quản lý việc ghép nội dung; không cần dựng lại state từ mọi event |
| Hiển thị chọn model hoặc danh sách cuộc trò chuyện | Session model/thread APIs, `session.modelChanged`, các notification Session tương ứng | Không dùng `state_changed` thay cho toàn bộ dữ liệu sidebar |
| Thêm tool sau khi ứng dụng đã đóng gói | `tessar.tools.register()` | PluginManager khi host cần load từ filesystem/npm |
| Thêm provider hoặc đổi nơi lưu state | `tessar.models.register()` / `tessar.storage.register()` | Không cần tự viết hook cho từng lần gọi model hoặc từng lần ghi DB |
| Thêm skill, memory vào context gửi model | `context.prepare` | `tessar.state.define()` nếu cần lưu tiến độ/dữ liệu plugin; dùng section `order` cho thứ tự instruction |
| Compact history gửi model | `context.prepare` + plugin state lưu summary/mốc đã xử lý | Lời gọi model phụ nếu cách compact cần LLM; thay request không tự xóa history đã lưu |
| Kiểm soát tool được thấy hoặc được chạy | `tools.select` để lọc danh sách; `tool.before` để cho phép/từ chối/tạm dừng thực thi | `tool.prepare` khi cần sửa arguments trước kiểm tra |
| Làm tool hỏi user | `context.suspend()` bên trong tool và `resume()` của tool | `interruptions.register()` cho policy yêu cầu approval từ decision hook, không bắt buộc với tool hỏi user |
| Ghi log hoặc gửi trace | Dùng LoggerPlugin / OpenTelemetryPlugin có sẵn | Chỉ nghe lifecycle model/tool/stream nếu tự viết exporter |
| Nhận tin từ background task hoặc dịch vụ ngoài | `agent.sendSignal()` với target phù hợp | `followUp()` khi muốn một input đợi lượt hiện tại kết thúc; `emit()` không thay thế hai API này |
| Làm delegate/subagent | Tạo Agent độc lập và tool điều phối; `tessar.agent.register()` nếu Agent do plugin cung cấp | Process, context mới/fork và trả kết quả do plugin quyết định |

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
  → model.select → tools.select → context.prepare → model.request
  → model.start → message.delta / model.usage → model.response
  → message.prepare → message.beforeCommit → message.committed → model.end
  → nếu có tool: tool.prepare → tool.before → tool.start
                 → tool.update → tool.result → message.prepare/commit → tool.end
  → turn.end → turn.decision
  → turn tiếp theo hoặc stream.beforeEnd → stream.end
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
services; riêng publisher như `state_changed`/Session notification có thể dispatch
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
- **T**: `ThreadHookContext`: H + `thread` bắt buộc.

`void` ở cột Return nghĩa là notification/barrier không có kết quả điều khiển.
Type được tham chiếu như `ModelRequest`, `ThreadInfo` là type public trong core.

63 event built-in hiện tại:

### Framework và UI

| Map (string nếu khác) | Kind | event.payload | Return / context | Khi nào dùng? |
| --- | --- | --- | --- | --- |
| `ready` | notification | `{ agentId: string; }` | `void` / H | Khởi động kết nối hoặc dịch vụ của plugin sau khi Controller ready; không phải báo mỗi lần model sẵn sàng. |
| `shutdown` | barrier | `{}` | `void` / H | Chờ tác vụ cần hoàn tất trước khi Controller đóng; cleanup tài nguyên riêng dùng defer. |
| `diagnostic` | notification | `{ error: ErrorInfo; }` | `void` / H | Thu lỗi từ observer, plugin hoặc runtime để ghi log/cảnh báo; không dùng quyết định retry. |
| `stateChanged`<br>`"state_changed"` | notification | `{ state: RuntimeState; }` | `void` / H | Render lại UI từ snapshot mới, gồm nội dung đang stream, tool, interrupt và queue. |

### Session

| Map (string nếu khác) | Kind | event.payload | Return / context | Khi nào dùng? |
| --- | --- | --- | --- | --- |
| `session.created` | notification | `{ model: ModelRef; }` | `void` / S | Theo dõi một Session mới, ví dụ ghi audit hoặc cập nhật danh sách phiên. |
| `session.modelChanged`<br>`"session.model-changed"` | notification | `{ previous: ModelRef; model: ModelRef; previousOptions?: JsonObject; options?: JsonObject; }` | `void` / S | Cập nhật model/options hiển thị hoặc ghi audit sau khi đổi model của Session thành công. |
| `session.threadCreated`<br>`"session.thread-created"` | notification | `{ threadId: string; }` | `void` / S | Cập nhật danh sách và lựa chọn cuộc trò chuyện sau thao tác tạo qua Session. |
| `session.threadSwitched`<br>`"session.thread-switched"` | notification | `{ previousThreadId: string \| null; threadId: string; }` | `void` / S | Đổi tiêu đề, tab hoặc dữ liệu phụ khi Session chọn Thread khác. |
| `session.threadRenamed`<br>`"session.thread-renamed"` | notification | `{ threadId: string; title: string; }` | `void` / S | Cập nhật tên cuộc trò chuyện trong UI của Session. |
| `session.threadForked`<br>`"session.thread-forked"` | notification | `{ sourceThreadId: string; threadId: string; }` | `void` / S | Hiển thị nhánh mới sau thao tác fork qua Session. |
| `session.threadDeleted`<br>`"session.thread-deleted"` | notification | `{ threadId: string; }` | `void` / S | Bỏ cuộc trò chuyện đã xóa khỏi UI của Session. |
| `session.inputQueued`<br>`"session.input-queued"` | notification | `{ receipt: QueuedInputReceipt; }` | `void` / S | Hiển thị input followUp đang đợi; không coi là input đã gửi model. |
| `session.inputDiscarded`<br>`"session.input-discarded"` | notification | `{ receipt: QueuedInputReceipt; cause: string; }` | `void` / S | Báo input đang đợi bị bỏ và nguyên nhân. |
| `session.beforeClose`<br>`"session.before-close"` | barrier | `{}` | `void` / S | Hoàn tất phần việc gắn với Session trước khi đóng; không dùng thay cleanup toàn plugin. |
| `session.closed` | notification | `{}` | `void` / S | Ngừng quan sát và cập nhật UI khi Session đã đóng. |
| `session.model.beforeChange`<br>`"session.model.before-change"` | decision | `{ previous: ModelRef; model: ModelRef; previousOptions?: JsonObject; options?: JsonObject; }` | `OperationDecision` / S | Cho phép/từ chối người dùng đổi model hoặc options theo policy ứng dụng. |
| `session.thread.beforeSwitch`<br>`"session.thread.before-switch"` | decision | `{ previousThreadId: string \| null; threadId: string; }` | `OperationDecision` / S | Cho phép/từ chối Session chuyển sang Thread được yêu cầu. |

### Thread

| Map (string nếu khác) | Kind | event.payload | Return / context | Khi nào dùng? |
| --- | --- | --- | --- | --- |
| `thread.prepare` | transformation | `CreateThreadOptions` | `CreateThreadOptions` / H | Bổ sung dữ liệu khởi tạo mặc định, ví dụ metadata hoặc tin nhắn mở đầu; giữ scope và ID đã cấp. |
| `thread.started` | notification | `ThreadInfo` | `void` / H | Ghi audit hoặc liên kết tài nguyên khi Thread được tạo; không phải mỗi lần resume hoặc gọi model. |
| `thread.beforeShutdown`<br>`"thread.before-shutdown"` | barrier | `{ threadId: string; }` | `void` / H | Chờ giải phóng phần việc gắn với một Thread handle trước khi handle đóng. |
| `thread.shutdown` | notification | `{ threadId: string; }` | `void` / H | Biết Thread handle đã đóng; không có nghĩa dữ liệu cuộc trò chuyện bị xóa. |
| `thread.updated` | notification | `{ checkpointId: string; revision: number; }` | `void` / H | Hiện lặp notification checkpoint.committed; không dùng làm tín hiệu tổng quát cho rename/delete. |
| `thread.beforeFork`<br>`"thread.before-fork"` | decision | `{ threadId: string; options: ForkOptions; }` | `OperationDecision` / T | Kiểm tra policy trước khi tạo nhánh lịch sử. |
| `thread.forked` | notification | `{ threadId: string; forkedThreadId: string; }` | `void` / T | Liên kết nhánh mới hoặc ghi audit quan hệ fork ở tầng Thread. |
| `thread.beforeRename`<br>`"thread.before-rename"` | decision | `{ threadId: string; title: string; }` | `OperationDecision` / T | Kiểm tra quyền/quy tắc đặt tên trước khi đổi tiêu đề. |
| `thread.renamed` | notification | `{ threadId: string; title: string; }` | `void` / T | Đồng bộ index hoặc ghi audit sau khi Thread đổi tên. |
| `thread.beforeDelete`<br>`"thread.before-delete"` | decision | `{ threadId: string; permanent?: boolean; }` | `OperationDecision` / T | Kiểm tra policy trước khi xóa mềm hoặc purge vĩnh viễn. |
| `thread.deleted` | notification | `{ threadId: string; permanent?: boolean; }` | `void` / T | Dọn tham chiếu bên ngoài hoặc ghi audit sau khi thao tác xóa thành công. |

### Input và Stream

| Map (string nếu khác) | Kind | event.payload | Return / context | Khi nào dùng? |
| --- | --- | --- | --- | --- |
| `input.prepare` | transformation | `InputPreparation` | `InputPreparation` / E | Biến đổi input mới, xử lý slash command, trả câu trả lời trực tiếp hoặc từ chối trước loop. |
| `input.received` | notification | `{ messages: readonly MessageData[]; }` | `void` / H | Ghi nhận input đã được nhận sau chuẩn bị; không sửa input hoặc history. |
| `stream.before` | decision | `{ input: readonly MessageData[]; }` | `ControlDecision` / D | Cho phép, dừng hoặc yêu cầu xác nhận trước khi bắt đầu loop của lượt này. |
| `stream.started` | notification | `{ modelRef: ModelRef; checkpointId: string; startedAt?: string; }` | `void` / H | Mở log/trace cho lượt chạy và nhận identity của Stream. |
| `stream.beforeEnd`<br>`"stream.before-end"` | barrier | `StreamOutcome` | `void` / H | Chờ một bước đồng bộ trước khi lượt được chốt kết thúc; không thay đổi output bằng return. |
| `stream.end` | notification | `StreamOutcome` | `void` / H | Đọc status/output/usage cuối của lượt để kết thúc tác vụ UI hoặc log/trace. |
| `stream.error` | notification | `{ target?: "execution" \| "consumer"; error: ErrorInfo; lastKnownCheckpointId: string \| null; persistedStatus: string \| null; startedAt?: string; endedAt?: string \| null; }` | `void` / H | Báo lỗi execution hoặc consumer; đọc target để phân biệt phạm vi lỗi. |
| `stream.suspended` | notification | `{ checkpointId: string; interrupt: InterruptRecord; }` | `void` / H | Hiển thị câu hỏi/approval từ interrupt và chờ ứng dụng cung cấp câu trả lời. |
| `stream.resumed` | notification | `{ checkpointId: string; interruptId: string \| null; reason: string; }` | `void` / H | Tiếp tục hiển thị/theo dõi một Stream được resume hoặc recovery, theo payload.reason. |
| `stream.cancel` | notification | `{ reason: string; }` | `void` / H | Ghi nhận yêu cầu/hành động hủy; trạng thái kết thúc vẫn đọc từ stream.end hoặc lỗi. |

### Turn, context và tool selection

| Map (string nếu khác) | Kind | event.payload | Return / context | Khi nào dùng? |
| --- | --- | --- | --- | --- |
| `turn.start` | notification | `{ turnId: string; index: number; startedAt?: string; }` | `void` / H | Theo dõi bước tiếp theo trong loop; mở span hoặc thống kê theo Turn. |
| `turn.end` | notification | `{ turnId: string; usage: UsageSummary; startedAt?: string; endedAt?: string \| null; }` | `void` / H | Chốt số liệu và thời gian của Turn; chưa chắc toàn bộ Stream đã kết thúc. |
| `turn.decision` | decision | `{ turnId: string; hadTools: boolean; }` | `ControlDecision` / D | Dừng loop hoặc yêu cầu thêm Turn sau bước vừa hoàn tất. |
| `context.prepare` | transformation | `ModelRequest` | `ModelRequest` / E | Dựng instruction, thêm skill/memory, chọn history hoặc thay bằng summary cho primary model. |
| `tools.select` | transformation | `readonly ToolDescription[]` | `readonly ToolDescription[]` / E | Chọn tập tool primary model được thấy ở lần gọi sắp tới; không phải kiểm tra quyền thực thi. |

### Model

| Map (string nếu khác) | Kind | event.payload | Return / context | Khi nào dùng? |
| --- | --- | --- | --- | --- |
| `model.select` | decision | `{ model: ModelRef; }` | `ControlDecision` / D | Chọn ModelRef cho lần gọi primary model tiếp theo; không thay model bằng sửa request.model. |
| `model.request` | transformation | `ModelRequest` | `ModelRequest` / E | Áp dụng quy tắc request cuối cho cả primary và auxiliary, ví dụ options dùng chung. |
| `model.start` | notification | `{ attemptId: string; startedAt?: string; model: ModelRef; request?: ModelRequest; purpose?: "primary" \| "auxiliary"; turnId?: string; parentToolExecutionId?: string \| null; }` | `void` / H | Đọc request thực tế của attempt để ghi trace input/model và thời điểm bắt đầu. |
| `model.end` | notification | `{ attemptId: string; response: ModelResponse; purpose?: "primary" \| "auxiliary"; startedAt?: string; endedAt?: string \| null; }` | `void` / H | Đọc response cuối, usage và thời gian của một attempt thành công; không có nghĩa hết Stream. |
| `model.response` | transformation | `ModelResponse` | `ModelResponse` / E | Biến đổi response primary trước khi runtime tạo các tool execution và lưu assistant message. |
| `model.usage` | notification | `{ attemptId: string; usage: ModelUsage; purpose?: "primary" \| "auxiliary"; }` | `void` / H | Theo dõi usage do provider phát trong lúc gọi; dữ liệu cuối có thể chỉ nằm ở model.end. |
| `model.error` | notification | `{ attemptId: string; error: ErrorInfo; purpose?: "primary" \| "auxiliary"; startedAt?: string; endedAt?: string \| null; }` | `void` / H | Ghi lỗi của một attempt; không tự retry chỉ vì handler nghe event này. |
| `model.recover` | decision | `{ attemptId: string; error: ErrorInfo; }` | `ControlDecision` / D | Quyết định thử lại primary model sau lỗi hoặc suspend để chờ xử lý; vẫn chịu limits. |

### Message

| Map (string nếu khác) | Kind | event.payload | Return / context | Khi nào dùng? |
| --- | --- | --- | --- | --- |
| `message.prepare` | transformation | `MessageData` | `MessageData` / E | Áp dụng quy tắc chung cho message đi qua pipeline, ví dụ thêm metadata; giữ identity/role/correlation. |
| `message.beforeCommit`<br>`"message.before-commit"` | barrier | `{ message: MessageData; }` | `void` / H | Chờ kiểm tra hoặc audit trước khi message được đưa vào commit; không sửa message qua return. |
| `message.delta` | notification | `{ messageId: string; partId: string; partKind: "text" \| "reasoning"; delta: string; attemptId: string; }` | `void` / H | Đọc text/reasoning tăng dần khi tự xử lý từng phần; UI snapshot không cần tự ghép từ đây. |
| `message.committed` | notification | `{ message: MessageData; checkpointId: string; }` | `void` / H | Theo dõi message đã lưu bền vững hoặc đồng bộ index bên ngoài theo checkpoint. |

### Tool và checkpoint

| Map (string nếu khác) | Kind | event.payload | Return / context | Khi nào dùng? |
| --- | --- | --- | --- | --- |
| `tool.prepare` | transformation | `ToolPreparation` | `ToolPreparation` / E | Biến đổi arguments trước khi kiểm tra policy và thực thi tool; không thay Tool implementation bằng sửa field tool. |
| `tool.before` | decision | `ToolPreparation` | `ControlDecision` / D | Cho phép/từ chối hoặc suspend xin approval cho một tool call cụ thể. |
| `tool.start` | notification | `{ toolExecutionId: string; startedAt?: string \| null; toolCallId: string; turnId?: string; name?: string; arguments?: JsonObject; }` | `void` / H | Mở log/span cho tool thực sự bắt đầu, kèm arguments và execution ID. |
| `tool.update` | notification | `{ toolExecutionId: string; progress: JsonValue; }` | `void` / H | Hiển thị tiến độ do chính tool chủ động emit, ví dụ số file đã xử lý. |
| `tool.end` | notification | `{ toolExecutionId: string; toolCallId: string; result: MessageData; status: string; startedAt?: string \| null; endedAt?: string \| null; }` | `void` / H | Đọc kết quả và status tool khi runtime publish result; chốt log/span theo toolExecutionId. |
| `tool.error` | notification | `{ toolExecutionId: string; error: ErrorInfo; startedAt?: string \| null; endedAt?: string \| null; }` | `void` / H | Ghi nhận lỗi tool; runtime vẫn có thể tạo ToolMessage báo lỗi cho model. |
| `tool.result` | transformation | `MessageData` | `MessageData` / E | Biến đổi ToolMessage, ví dụ rút gọn output trước khi đi tiếp qua message pipeline. |
| `checkpoint.committed` | notification | `{ checkpointId: string; revision: number; }` | `void` / H | Biết checkpoint đã commit để đọc/đồng bộ dữ liệu; không đồng nghĩa có một message mới. |

### Payload dùng chung

```ts
interface InputPreparation {
  messages: readonly MessageData[];
  handled?: { output: readonly MessageData[] };
  rejected?: ErrorInfo;
}
interface ToolPreparation {
  tool: ToolDescription;
  toolCallId: string;
  toolExecutionId: string;
  arguments: JsonObject;
}
interface StreamOutcome {
  startedAt?: string;
  endedAt?: string | null;
  status: string;
  reason: string | null;
  output: readonly MessageData[];
  usage: UsageSummary;
  error: ErrorInfo | null;
  interrupt: InterruptRecord | null;
}
interface QueuedInputReceipt { id: string; threadId: string; }
```

`CreateThreadOptions` ở `thread.prepare` có `id?`, `title?`, `scope?`,
`instructions?`, `messages?`, `metadata?`. Đây là payload hook; public
`session.thread.create()` chỉ nhận `id/title/messages/metadata`, scope lấy từ
Session. Hook không được đổi scope hoặc ID mà caller đã cung cấp.

`state_changed.payload.state` là snapshot phục vụ UI, gồm `status`, `messages`,
`currentMessage`, `tools`, `interrupt`, `queuedInputs`, `error`. Đây không phải
một checkpoint commit mới; `session.state.get()` chỉ lấy snapshot hiện tại.

`tool.end` là lúc publish kết quả, có thể muộn hơn execution hoàn tất; tool song
song vẫn publish kết quả theo thứ tự call. Denied/recovered tool có thể có end
mà không có start mới trong segment. `model.start` dùng `attemptId`; tool dùng
`toolExecutionId` và provider `toolCallId`, không hoán đổi các ID này.

`turn.start.index` là index của Stream, bắt đầu từ 0. Số Turn liên tục của plugin
tracing trên Thread là cách plugin tổ chức hiển thị, không đổi index này.
Auxiliary model call có `purpose: "auxiliary"`, vẫn phát model events riêng.

`stream.error.target` mặc định hiểu là `execution`. `consumer` nghĩa là delivery
consumer bị lỗi/overflow; detach consumer không tự hủy execution. Hook và
Stream/subscriber cùng quan sát được lỗi nhưng plugin không nên coi consumer
error là provider hoặc Agent thất bại.

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
interface InterruptionDefinition<R, D extends ControlDecision, P extends JsonValue> {
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

### State của plugin — chỉ E/D

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
| `context.state.snapshots()` | Không parameter → `readonly PluginStateSnapshot[]` |
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
| `context.models.stream(options)` | `{ model: ModelRef; request: ModelRequest; purpose: "auxiliary" }` | `AsyncIterable<ModelChunk>` |
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

## 11. Event/API nào trùng hoặc có thể gây hiểu nhầm?

Đánh giá dưới đây dựa trên publisher trong source hiện tại. Không có built-in
plugin dùng một hook chưa đủ để kết luận hook đó vô dụng cho plugin bên ngoài.
Đây là đánh giá và hướng chọn API; mục này không xóa hoặc đổi contract hiện tại.

| Cặp/nhóm | Kết luận từ code | Hướng sử dụng / đề xuất |
| --- | --- | --- |
| `thread.updated` / `checkpoint.committed` | **Trùng rõ:** cùng một hàm commit phát liên tiếp cả hai cho cùng checkpoint với cùng payload `checkpointId/revision`; envelope vẫn có sequence/timestamp riêng | Chọn `checkpoint.committed` khi quan sát commit. `thread.updated` là ứng viên bỏ; hiện không phải notification tổng quát cho mọi thay đổi Thread, ví dụ rename |
| `session.threadCreated/Renamed/Forked/Deleted` / `thread.started/renamed/forked/deleted` | Thao tác qua Session tạo hai notification cho cùng công việc, ở hai bước khác nhau | Session event báo thao tác của Session đã xong; Thread event báo thao tác ở tầng Thread. Plugin audit Thread chọn nhóm Thread; UI theo Session chọn nhóm Session. Chưa tương đương hoàn toàn để xóa ngay |
| `context.prepare` / `model.request` | Trên primary model, cả hai chạy nối tiếp và nhận `ModelRequest`; auxiliary chỉ qua `model.request` | Skill/memory/context management chọn `context.prepare`. Quy tắc request phải áp dụng cả lời gọi phụ chọn `model.request`; không đăng ký cùng phép sửa ở cả hai |
| `model.response` / `message.prepare` / `tool.result` | Có thể cùng sửa assistant/tool message, nhưng phạm vi khác: response của primary model, message đi qua prepare, và kết quả tool | Chỉ sửa kết quả tool chọn `tool.result`; chỉ xử lý response model chọn `model.response`; quy tắc chung cho message chọn `message.prepare`. Không xóa chỉ vì payload có phần giống nhau |
| `model.usage` / `model.end` | Usage có thể đến trong lúc stream; end chứa response cuối. Không phải mọi provider đều phát chunk usage riêng | Dùng end cho số liệu cuối; nghe usage nếu cần dữ liệu trung gian. Consumer cuối cùng cần xét `response.usage`, không cộng cùng một tổng usage hai lần |
| `message.delta` / `state_changed` | Một bên là phần nội dung tăng thêm; bên kia là snapshot đã tổng hợp cho UI | UI dùng snapshot bắt đầu bằng `state_changed`. Giữ delta cho consumer cần xử lý từng phần và tracing; không bắt UI phải dùng cả hai |
| Các hook `before*` dạng barrier | Có ích khi cần chờ một bước kiểm tra/đồng bộ hoàn tất; không phải transformation và không trả policy decision | Chỉ dùng khi thực sự cần chặn boundary bằng việc chờ handler. Cleanup plugin thông thường dùng `defer`; notification end không thay cho barrier |
| `ControlDecision` dùng chung nhiều boundary | **Contract quá rộng:** TypeScript cho thấy cả `select/retry/deny/...`, nhưng từng caller chỉ xử lý một tập con ở mục 6 | Đây là phần nên thu hẹp type theo boundary để dev không return một quyết định bị bỏ qua. Không cần thêm event để giải quyết |
| `ToolDecision` / `TurnDecision` / `InputDecision` | Helper tạo object; không mở thêm cơ chế thực thi | Tùy chọn cho autocomplete, có thể return object đúng type trực tiếp; không cần học helper như một subsystem riêng |

Các khác biệt quan trọng được đối chiếu tại
[checkpoint publisher](../packages/core/src/engine/checkpoint.ts),
[primary loop](../packages/core/src/loop.ts),
[auxiliary calls](../packages/core/src/engine/services.ts) và
[Session operations](../packages/core/src/session.ts).
