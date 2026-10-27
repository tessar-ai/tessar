# Audit phạm vi mở rộng của Tessar

Cập nhật 2026-10-27: bảng bên dưới là audit lịch sử trước triển khai. Đã xử lý
notification trùng, tools.select, state serialization view, decision theo boundary,
provider.request và lời gọi model phụ dư model/purpose. Các barrier handle/finalization
đã bỏ; năm operation policy gate được giữ vì có quyền kiểm soát thực tế. Tracing
cập nhật state ở turn.start, không còn mượn model.select. Bộ lifecycle part và
Session model APIs đã triển khai; tham khảo [contract hiện tại](plugin-api-and-events.md).
Không dùng số event để đánh giá khả năng plugin.

## Kết quả cuối sau triển khai — 2026-10-27

Đã đối chiếu lại toàn repo sau thay đổi, review độc lập và sửa hai lỗi review:
abort adapter kết thúc im lặng và provenance lỗi tool identity của Responses.
Các regression bao phủ cả primary/auxiliary và Responses/Chat, gồm tool-call ID trùng.
Audit độ phức tạp không phát hiện thêm hook, dependency hoặc lớp trừu tượng cần gỡ.
Không xóa policy gate có quyền thực tế hoặc gộp implementation backend độc lập.

Đã chạy typecheck, build, check:boundaries; 488 package tests và 43 integration tests
qua. 39 test bị skip; chưa kiểm thử lại cloud provider/dashboard hoặc database server
thật. Không đổi schema DB, thêm dependency, commit, push hoặc publish trong đợt này.

Kết luận ponytail-audit: **Lean already. Ship.** Đây là kết quả audit trong phạm vi
độ phức tạp, không phải cam kết code không còn lỗi.

## Bản audit lịch sử trước triển khai

Đối chiếu source ngày 2026-10-26. Phạm vi: toàn bộ 63 event built-in,
PluginContext, context trong hook/tool và lifecycle load/attach/detach.
Đây là báo cáo thiết kế, chưa thay đổi API hoặc code.

Cập nhật sau audit: phần `model.request` đã được thay bằng `provider.request`
tại boundary native body sau adapter. `context.prepare` giữ phạm vi loop Agent;
request chuẩn hóa của model phụ do caller tự dựng. Các phát hiện khác bên dưới
vẫn là kết quả audit, không đồng nghĩa đã được triển khai hoặc duyệt xóa.

Hướng xử lý đã thống nhất được ghi tại
[architecture notes](architecture-notes.md#cập-nhật-2026-10-26-hướng-hoàn-thiện-plugin-api-đã-chốt).
Định hướng đã chốt không đồng nghĩa từng ứng viên trong bảng dưới đây đã được
duyệt xóa; tên event và contract thay thế vẫn cần thiết kế chi tiết.

## Tiêu chí

“Anything are plugin” nghĩa là plugin có đủ điểm nối để thêm hành vi mà không
phải sửa core. Không có nghĩa mọi bước nội bộ phải có event riêng.

Với mỗi điểm nối, cần trả lời:

1. Plugin có thể thay đổi quyết định/dữ liệu nào, hoặc quan sát dữ liệu riêng nào?
2. Một điểm nối đã có có làm được việc đó với cùng thời điểm và bảo đảm không?
3. Nếu bỏ, khả năng đã nằm trong mục tiêu Tessar nào sẽ không triển khai được?

Điểm chặn trước thực thi không thể thay bằng thông báo sau thực thi. Notification
không cần sửa được execution mới có giá trị: UI, log và trace cần dữ liệu thật
ở đúng thời điểm. Ngược lại, một event có người nghe để ghi log chưa chứng minh
nó cần tồn tại riêng. Test chứng minh hành vi, không tự chứng minh nhu cầu.

## Các phát hiện cần xử lý trước

| Mức | Phát hiện | Đề xuất và khả năng bị ảnh hưởng |
| --- | --- | --- |
| Dư chắc chắn | `thread.updated` và `checkpoint.committed` được cùng hàm commit phát liên tiếp với cùng checkpoint/revision | Bỏ `thread.updated`. Không mất quyền can thiệp hoặc dữ liệu commit; envelope sequence/timestamp riêng không tạo thêm nghiệp vụ |
| Chồng thông báo | `session.threadCreated/threadRenamed/threadForked/threadDeleted` lặp công việc đã có `thread.started/renamed/forked/deleted` | Hợp nhất về sự kiện thao tác Thread có identity đủ dùng. Phải giữ đúng thời điểm Session đã hoàn tất cập nhật; không xóa cơ học vì hai publisher hiện chạy ở hai bước khác nhau |
| Quyền sửa đã có | `tools.select` biến đổi danh sách tool, nhưng `context.prepare` đã nhận ModelRequest.tools và cũng được thay danh sách đó | Gộp vào context.prepare; giữ kiểm tra tool đã đăng ký tại boundary sau biến đổi. Không mất khả năng lọc tool; tool.before vẫn cần để chặn thực thi |
| Contract gây cảm giác có quyền nhưng caller không dùng | Các execution decision dùng chung `ControlDecision`; chẳng hạn `model.select` chỉ dùng select, `model.recover` chỉ dùng retry ngoài suspension | Thu hẹp result type theo boundary. Không thêm event; không để autocomplete quảng cáo một quyết định runtime bỏ qua |
| Phạm vi chưa rõ | Primary gọi `context.prepare` rồi `model.request`, cả hai nhận ModelRequest; auxiliary chỉ gọi `model.request` | Chốt một điểm chuẩn bị context chính và một phạm vi request chung có lý do rõ nếu cần giữ cả hai. Đây không phải hai tầng normalized/provider-native payload như tên gọi có thể gợi ý. Không gộp trước khi bảo toàn cách xử lý auxiliary |
| API lặp dữ liệu | `context.models.stream({ model, request: { model, ... }, purpose: "auxiliary" })` | Caller không chọn được purpose nào khác, nên purpose thuộc runtime. Chọn một nguồn model duy nhất; giữ ModelAttempt.purpose trong records/trace. Không cắt lời gọi model phụ |
| Rò helper nội bộ | `context.state.snapshots()` trả cấu trúc serialization mà engine dùng khi commit | Thu hẹp khỏi view API dành cho plugin; engine vẫn giữ method. Plugin đọc/cập nhật definition đã đăng ký; đọc checkpoint khi cần snapshot đã commit |
| Mượn sai boundary | OpenTelemetry nghe `model.select` để cập nhật bộ đếm Turn, không chọn model | Rà lại quyền truy cập state tại lifecycle boundary. Không lấy trường hợp sử dụng này để biện minh cho model.select; không thêm một event chỉ dành cho tracing |

Nguồn đối chiếu:
[commit publisher](../packages/core/src/engine/checkpoint.ts),
[primary loop](../packages/core/src/loop.ts),
[auxiliary calls](../packages/core/src/engine/services.ts),
[decision dispatcher](../packages/core/src/events/dispatcher.ts),
[tracing state](../packages/opentelemetry/src/lifecycle.ts).

## Mười event cần chứng minh nhu cầu trước khi giữ trong phạm vi tối thiểu

Các event dưới đây có hành vi thật, nhưng chưa đủ cơ sở để coi là điểm mở rộng
tối thiểu đã cần. Đề xuất mặc định là đưa khỏi bộ hook tối thiểu nếu không có
khả năng sản phẩm đã chốt cần chúng. Đây không phải tuyên bố bỏ chúng không mất gì.

| Event | Quyền riêng hiện có | Điều mất nếu bỏ / vì sao chưa đủ lý do giữ |
| --- | --- | --- |
| `thread.beforeFork` | Gate allow/deny trước fork | Mất policy plugin chặn mọi fork qua đường API này. Không mất fork, chọn checkpoint, kiểm tra an toàn hoặc copy/reset state; các việc đó đã có cơ chế riêng |
| `thread.beforeRename` | Gate trước rename | Mất policy plugin tập trung cho rename. Chưa có yêu cầu đã xác nhận cần biến đổi tên Thread thành một policy boundary riêng |
| `thread.beforeDelete` | Gate trước delete/purge | Mất policy plugin chặn xóa tập trung; event sau xóa không thay được nó. Chỉ giữ trong bộ tối thiểu nếu policy thao tác state là yêu cầu, không chỉ vì thao tác có tên delete |
| `session.model.beforeChange` | Gate trước đổi model/options của Session | Mất policy plugin chặn thao tác chọn model của Session. Khác với chọn model trong loop; `model.select` không thay hoàn toàn được gate này |
| `session.thread.beforeSwitch` | Gate trước đổi active Thread | Mất policy plugin chặn lựa chọn Thread. Không thay thế hay loại bỏ kiểm tra scope/quyền truy cập dữ liệu của core |
| `message.beforeCommit` | Chặn sau khi mọi message.prepare đã chạy và message được validate | Mất gate cuối trên message đã chuẩn hóa. Message transformation vẫn còn; chỉ thêm gate riêng khi thực sự cần kiểm tra kết quả sau toàn bộ transform |
| `stream.beforeEnd` | Chờ/chặn finalization của lượt | Mất bước mà lỗi handler có thể biến finalization thành failed. Log, trace hoặc việc nền không mặc nhiên cần quyền làm lượt trả lời thất bại |
| `session.beforeClose` | Chờ/chặn đóng Session handle | Mất bước đồng bộ có thể từ chối đóng handle. Không phải cleanup toàn plugin; tài nguyên plugin đã có disposer/defer |
| `thread.beforeShutdown` | Chặn Thread.dispose() | Gắn với handle cục bộ, không phải đóng/xóa cuộc hội thoại persisted. Chưa có lifecycle tài nguyên theo handle đủ rõ để coi là contract chung |
| `thread.shutdown` | Báo Thread handle đã dispose | Không đồng nghĩa Thread persisted hết hoạt động; handle khác có thể tồn tại. Ghi một dòng log đóng handle chưa đủ chứng minh cần event global |

Năm operation gate đầu không phải giả lập: chúng thật sự bổ sung policy tập
trung. Cần quyết định phạm vi đó có thuộc mục tiêu Tessar không; không thể vừa
bỏ chúng vừa hứa plugin vẫn áp policy lên mọi thao tác tương ứng.

## Bốn mươi sáu event có trách nhiệm đủ rõ để giữ

Các nhóm dưới đây bao phủ đủ 46 event; không yêu cầu một plugin dùng tất cả.

| Nhóm | Event | Khả năng cần bảo toàn |
| --- | --- | --- |
| Framework/UI (4) | `ready`, `shutdown`, `diagnostic`, `stateChanged` | Khởi động/tắt runtime, lỗi quan sát được và snapshot realtime cho UI |
| Session (6) | `session.created`, `session.modelChanged`, `session.threadSwitched`, `session.inputQueued`, `session.inputDiscarded`, `session.closed` | Các thay đổi riêng của Session; UI và plugin không phải suy ra lựa chọn/queue/lifecycle từ text message |
| Thread (5) | `thread.prepare`, `thread.started`, `thread.forked`, `thread.renamed`, `thread.deleted` | Chuẩn bị dữ liệu khởi tạo và quan sát thay đổi cuộc hội thoại; không giả định có Session |
| Input/Stream (9) | `input.prepare`, `input.received`, `stream.before`, `stream.started`, `stream.end`, `stream.error`, `stream.suspended`, `stream.resumed`, `stream.cancel` | Xử lý input, gate cả lượt, và quan sát tiến trình/kết quả/interrupt/cancel của execution |
| Loop/context (4) | `turn.start`, `turn.end`, `turn.decision`, `context.prepare` | Đơn vị Turn, quyền yêu cầu tiếp tục/dừng, context window và tập tool model được thấy |
| Model (7) | `model.select`, `model.start`, `model.end`, `model.response`, `model.usage`, `model.error`, `model.recover` | Routing từng lần gọi, request/response/usage cho trace, sửa response trước tạo tool records, và phục hồi attempt |
| Message (3) | `message.prepare`, `message.delta`, `message.committed` | Chuẩn hóa message, quan sát phần tăng thêm và biết message đã commit |
| Tool/checkpoint (8) | `tool.prepare`, `tool.before`, `tool.start`, `tool.update`, `tool.end`, `tool.error`, `tool.result`, `checkpoint.committed` | Chuẩn hóa arguments, permission/approval, tiến độ/kết quả thực thi, sửa output và mốc persistence |

Đặc biệt, giữ các ranh giới sau dù không có built-in tương ứng:

- `tool.before`: plugin permission phải quyết định trước khi tool gây tác động.
  `tool.start/end` hoặc UI không thay được quyền này.
- `context.prepare`: context window, skill, memory và compaction phải sửa request
  gửi model mà không buộc sửa lịch sử đã lưu.
- `tool.prepare` trước `tool.before`: chuẩn hóa arguments trước khi policy duyệt
  và executor sử dụng. Đây là hai trách nhiệm có thứ tự, không chỉ hai tên gọi.
- `model.response`: chạy trước tạo tool execution records. Chuyển mọi việc sang
  `message.prepare` phía sau không giữ nguyên khả năng sửa tool calls của response.
- Lọc tool khác permission: gộp tools.select vào context.prepare vẫn cho plugin
  chọn tool model được thấy. Tool.before giữ quyền chặn thực thi độc lập; không
  hứa chỉ ẩn tool là đã có policy chặn.
- Notification model/tool không bị thay hết bằng `state_changed`: snapshot UI
  không cung cấp nguyên vẹn request, error hoặc số liệu của từng attempt.

Tổng kiểm kê: 46 giữ + 10 cần chứng minh nhu cầu + 4 notification cần hợp nhất
+ 1 tools.select cần gộp + 1 trùng cần bỏ + 1 model.request cần làm rõ phạm vi = 63.

## Plugin API: giữ khả năng chung, không bắt plugin dùng cả bộ

| API setup | Kết luận | Khả năng riêng |
| --- | --- | --- |
| `hook()` | Giữ | Nối hành vi vào boundary runtime; trọng tâm là chất lượng boundary, không phải số lượng |
| `emit()` | Giữ | Plugin tự định nghĩa giao tiếp với nhau thay vì yêu cầu core thêm event cho từng tính năng |
| `defer()` / disposer từ setup | Giữ | Thu hồi tài nguyên khi detach/dispose; hai cách đăng ký cleanup, không phải hai subsystem |
| `tools.register()` | Giữ | Thêm tool sau khi host đã đóng gói |
| `models.register()` | Giữ | Thêm provider mà host chưa biết lúc build |
| `storage.register()` | Giữ | Chọn backend cho hệ state chung; không đẩy toàn bộ persistence cho plugin tự làm |
| `agent.register()` | Giữ | Plugin cung cấp Agent độc lập; không ép process, delegate tool hay mô hình subagent cụ thể |
| `state.define()` | Giữ | State có namespace, schema/migration và fork behavior để plugin có persistence |
| `interruptions.register()` | Giữ | Khôi phục policy decision sau approval; tool.suspend không thay hoàn toàn vì policy không sở hữu implementation của tool |
| `registry.register()` | Giữ | Chia sẻ capability tự định nghĩa để core không phải có API riêng cho từng sandbox, memory store hay dịch vụ khác |
| `effects.register()` | Giữ như capability nâng cao, không làm điều kiện viết plugin | Ghi nhận/reconcile thao tác ngoài khi execution được khôi phục. Không đồng nhất với recovery của toàn bộ một Tool; chưa có cơ sở xóa chỉ vì built-in chưa dùng |

Context đọc registry/Thread/Session, state get/update/commit và owned-state CAS
là các primitive để plugin tự kết hợp. Không thêm riêng MemoryService,
SubagentService hoặc SchedulerService vào core để thay thế việc kết hợp đó.

`context.models.stream()` vẫn cần cho model phụ có attempt/usage gắn với lượt
hiện tại; chỉ rút phần parameter lặp. `context.events.emit()` giữ identity và
đường phát ra Stream/subscriber; setup emit không tự thay được nó.

PluginManager chỉ cần khi host muốn nhận module/npm bên ngoài. Controller nhận
instance và quản lý attach/detach là trách nhiệm khác. Không gộp chúng và bắt
người chỉ dùng plugin có sẵn phải dùng một loader.

## Hướng xử lý

1. Bỏ trùng chắc chắn, thu hẹp type/parameter quảng cáo khả năng không có.
2. Hợp nhất notification chồng nhau sau khi thống nhất thời điểm và identity.
3. Chốt phạm vi model.request và quyền state ở lifecycle boundary; không thêm
   hook riêng để chữa việc tracing đang phải dùng sai hook.
4. Với 10 event còn nghi vấn, quyết định rõ khả năng nào thuộc core tối thiểu.
   Event có semantics riêng nhưng ngoài phạm vi là ứng viên YAGNI; xóa nó là
   thay đổi phạm vi có chủ ý, không phải refactor không đổi hành vi.

Không đặt chỉ tiêu giảm còn một số event cụ thể. Chỉ xóa khi chỉ ra được thứ
thay thế tương đương hoặc xác nhận khả năng bị bỏ nằm ngoài phạm vi cần hỗ trợ.

## Phần thiếu: kiểm kê event hiện có chưa đủ để xác nhận khả năng mở rộng

Audit cũng phải tìm thông tin runtime đang làm mất, không chỉ tìm event để bỏ.

| Khả năng | Hiện tại | Đánh giá |
| --- | --- | --- |
| Nhận reasoning tăng dần | message.delta có partKind reasoning, partId và delta | Đã có thông tin; không cần thêm reasoning.delta chỉ để lặp cùng dữ liệu |
| Biết reasoning part bắt đầu/kết thúc | ModelChunk chỉ có message-delta, usage và response; không có part start/end | Thiếu lifecycle thật. Consumer suy ra lần đầu có delta nhưng không biết chính xác part đóng lúc nào. Model kết thúc không thay cho reasoning part kết thúc |
| Phân biệt nhiều reasoning/text part theo thời gian | Có partId khi delta tới, nhưng không có contract vòng đời đầy đủ | Cần thiết kế lifecycle content part chung hoặc reasoning lifecycle rõ ràng; không tự kết luận reasoning end chỉ vì text xuất hiện. Đây là phần cần review xuyên adapter/core/consumer |
| Nhận thay đổi effort của Session | session.modelChanged đã có previousOptions/options và vẫn phát khi switch cùng model ID với options khác | Nhu cầu có thật nhưng event chuyên biệt chưa bổ sung thông tin riêng. Tên event hiện tại chưa thể hiện rõ cả thay đổi options |
| Biết effort thực tế của một lần gọi | model.start có request.options | Phân biệt options dùng riêng cho attempt với thay đổi cấu hình Session. Hai Stream có thể override effort khác nhau; không có một effort level toàn Agent đang đổi qua lại |

Đề xuất: bổ sung phần thông tin lifecycle đang thiếu tại contract streaming, rồi
mới chốt tên event. Không thêm start/end giả chỉ để đủ bộ. Adapter chỉ có thể
phát mốc provider thực sự cung cấp hoặc mốc quan sát được đã được định nghĩa rõ;
vòng đời reasoning part không phải phép đo suy nghĩ nội bộ của model.

Lựa chọn sau audit: người dùng chọn lifecycle riêng cho text/reasoning/tool-call.
[Bản thiết kế streaming](superpowers/specs/2026-10-26-streaming-lifecycle-design.md)
đề xuất thay message.delta bằng delta event riêng, không phát hai luồng trùng
dữ liệu. Tên/payload cụ thể vẫn là bản nháp, chưa triển khai.

Với effort, trước hết làm rõ event thay đổi model/options và cách đọc effective
options. Chỉ thêm event effort riêng nếu Tessar chốt một contract effort chung;
hiện options vẫn theo provider, không phải enum effort toàn framework.

### Các ràng buộc cần giữ khi thiết kế streaming

Đối chiếu sâu hơn đường adapter → loop → StateView cho thấy những điểm sau
phải được giải quyết cùng contract, không chỉ thêm tên event:

- Responses hiện dùng item_id làm messageId của delta, nhưng decodeOutput dùng
  responseId cho assistant message cuối. Reasoning và text có thể thuộc các
  item khác nhau. Cần identity nhất quán để UI ghép nhiều part vào đúng message
  và thay draft bằng message đã commit mà không để lại bản nháp thừa.
- Chat Completions đang ghép tool-call arguments trong adapter rồi mới trả
  response cuối. Người dùng đã chọn không expose tool.call.delta; tiếp tục gom
  arguments nội bộ và chỉ trả object hoàn chỉnh khi kết thúc tạo lời gọi.
- Auxiliary model trả chunks cho caller nhưng hiện không phát message.delta
  qua execution hooks như primary. Lifecycle mới cần quan sát được theo
  attempt/purpose, đồng thời không đưa output phụ vào chat UI chính.
- Vòng đời tool-call part mô tả model đang tạo lời gọi; tool.start/end mô tả
  tool thực sự được thực thi. Không gộp hai nghĩa này hoặc bỏ tool.before.
- Provider không cung cấp mốc kết thúc từng part thì phải mô tả đúng mốc quan
  sát được; không khẳng định reasoning đã kết thúc chỉ vì text bắt đầu.
- Lỗi/hủy không được đóng part như thể đã hoàn tất thành công. Final response
  vẫn là kết quả authoritative; part event không tự tạo một commit history mới.

Nguồn: [Responses adapter](../packages/openai/src/adapter.ts),
[Responses codec](../packages/openai/src/codec.ts),
[Chat adapter](../packages/openai/src/chat-adapter.ts),
[StateView](../packages/core/src/runtime-state.ts) và
[auxiliary streaming](../packages/core/src/engine/services.ts).
