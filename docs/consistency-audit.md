# Tessar consistency audit

Ngày rà soát: 2026-10-24. Phạm vi: public exports, Agent/Controller/Session/Thread,
hooks, model adapters, tool registration, state/storage, logger và tracing.

Đây là báo cáo tính nhất quán về hành vi và trách nhiệm, không phải yêu cầu mọi
class có cùng method. Agent trả Stream, Session trả receipt qua subscription,
hay backend dùng driver khác nhau là những khác biệt hợp lý.

Trạng thái cập nhật 2026-10-25: **C01–C09 đã sửa và có regression tests**.
Các mục bên dưới giữ nguyên mô tả tại thời điểm audit để đối chiếu; phần cuối
ghi kết quả sửa và kiểm chứng hiện tại.

## Kết quả tại thời điểm audit

Có các trường hợp cùng một khả năng nhưng đổi đường sử dụng thì thay đổi contract.
Các kiểm thử hiện tại vẫn xanh vì phần lớn kiểm tra từng đường riêng, chưa kiểm
tra sự tương đương giữa chúng.

| Mã | Mức | Vấn đề | Bằng chứng |
| --- | --- | --- | --- |
| C01 | P1 | Tool schema được kiểm tra khác nhau khi resume từ Agent và plugin | Đã tái hiện với SQLite, đóng/mở runtime |
| C02 | P1 | Model instance dùng được ở Agent nhưng Session nhận rồi không chạy được | Đã tái hiện qua public API, provider giả lập offline |
| C03 | P1 | Lỗi cùng storage backend có nguồn `storage` hoặc `tessar` tùy operation | Đã tái hiện bằng lỗi storage được chủ động chèn |
| C04 | P1 | Timing đã thêm payload nhưng tracing chưa dùng thống nhất | Đối chiếu toàn bộ điểm phát và đọc lifecycle timing |
| C05 | P2 | Một số `stream.error` chỉ tới subscriber, không tới hook cùng tên | Đã tái hiện với Stream ID đã tồn tại |
| C06 | P2 | Controller đóng nhưng Session vẫn báo chưa dispose | Đã tái hiện qua public API |
| C07 | P2 | Có event có timestamp, có event không có | Đã bắt trực tiếp `ready`, `thread.started` và execution events |
| C08 | P2 | Object key của Agent tools chưa có tác dụng alias như hướng đã chốt | Đã tái hiện; API review cũng ghi nhận là khoảng trống |
| C09 | P2 | Hai API OpenAI built-in chưa chia sẻ cùng khả năng cấu hình protocol | Đối chiếu implementation, types và tài liệu |

P1: cần xử lý trước khi công bố contract đã thống nhất. P2: cần chốt/chuẩn hóa
trước khi mở rộng thêm API theo các đường này.

## C01 — Resume kiểm tra tool schema khác nhau theo nơi đăng ký

Nguồn: [runtime.ts](../packages/core/src/engine/runtime.ts:18),
[host.ts](../packages/core/src/plugins/host.ts:183),
[resume.ts](../packages/core/src/engine/resume.ts:37).

- Agent tools lưu `tool.configurationId`, vốn chứa schema, trong registry manifest.
- Plugin tools thường lưu `plugin.configurationId ?? null`. Chỉ khi có custom
  resume/schema mới ghép thêm `tool.configurationId`.
- Cùng tool `work`, cùng plugin/version, suspend tại `tool.before`, đổi schema
  bằng cách thêm một field optional rồi khởi động lại: Agent trả
  `ResumeIncompatible`; plugin tool vẫn chạy tiếp.

Ảnh hưởng: safety contract của continuation phụ thuộc cách cài tool, trong khi
`createTool()` tạo cùng một loại Tool cho cả hai.

Hướng thống nhất: một quy tắc tạo tool registration identity cho cả Agent và
plugin, kết hợp schema/configuration của Tool với identity plugin khi cần.
Giữ kiểm tra compatibility; không bỏ guard để làm hai đường giống nhau.

## C02 — Session nhận model instance nhưng làm mất adapter thực thi

Nguồn: [call.ts](../packages/core/src/engine/call.ts:22),
[controller.ts](../packages/core/src/controller.ts:264),
[session.ts](../packages/core/src/session.ts:592),
[registry.ts](../packages/core/src/models/registry.ts:55).

Agent mặc định dùng connection A. Tạo một OpenAIProvider khác cùng `providerId`
nhưng connection B:

```ts
await agent.generate("hello", { model: connectionB }); // completed
const session = await controller.createSession({
  model: connectionB,
  threadId: "chat",
}); // succeeds
await session.followUp("hello"); // subscription: ModelContextIncompatible
```

Đường Agent giữ executable adapter B. Đường Session lưu ref/connection B nhưng
khi chạy lại resolve qua provider factory của A. Trường hợp thử dùng stream giả
lập, không gọi API OpenAI hay tốn token.

Hướng thống nhất: model selection phải có cùng quy tắc resolve connection cho
Agent và Session. Instance được chấp nhận phải chạy được trong runtime hiện tại;
khả năng phục hồi connection qua restart cần được phân biệt rõ với điều đó.

## C03 — Nguồn lỗi storage chỉ được gắn ở một số boundary

Nguồn: [commit.ts](../packages/core/src/state/commit.ts:135),
[controller.ts](../packages/core/src/controller.ts:294),
[errors.ts](../packages/core/src/errors.ts:44).

`CommitCoordinator` gắn `source: "storage"`. Các port khác như
`sessions.compareAndSet()` được gọi trực tiếp; lỗi driver thông thường chưa có
origin sẽ bị `errorInfo()` mặc định thành `source: "tessar"`.

Đã chèn hai Error mới có cùng nội dung `Storage offline`: lỗi tạo Session cho
nguồn `tessar`, lỗi commit cho nguồn `storage`.

Ảnh hưởng: diagnostics, logger, tracing và logic phân biệt lỗi hạ tầng với lỗi
runtime không nhận cùng thông tin cho cùng backend.

Hướng thống nhất: định nghĩa boundary gắn provenance cho toàn bộ storage ports,
bao gồm reads, Session/owned state, ownership và commits. Giữ nguyên exception
gốc; không bọc mọi lỗi driver thành TessarError.

## C04 — Timing contract và consumer chưa được sửa đồng bộ

Nguồn: [event types](../packages/core/src/events/type.ts:61),
[trace.ts](../packages/opentelemetry/src/trace.ts:69),
[models.ts](../packages/opentelemetry/src/models.ts:96),
[lifecycle.ts](../packages/opentelemetry/src/lifecycle.ts:139),
[tools.ts](../packages/opentelemetry/src/tools.ts:64).

Thay đổi đang làm đã cung cấp record timestamps cho lifecycle Stream, Turn,
model và tool. Tuy nhiên tracing hiện vẫn:

- Dùng `tool.end.payload.endedAt` cho tool đã có span trong segment này.
- Dùng `event.timestamp` cho model end/error, Turn start/end và Agent root.
- Dùng checkpoint/resume boundaries khi mở segment tiếp theo.

Vì record được cập nhật trước commit/hook, những mốc này không có cùng ý nghĩa.
Chỉ thêm field chưa hoàn tất việc thống nhất. Đây là phần sửa đang dở trong
checkout, không được coi là finding đã giải quyết.

Hướng thống nhất: phân biệt thời điểm phát event, thời gian tác vụ trong record
và khoảng thời gian của một segment resume. Tracing/logger dùng chung contract
Tessar; không thêm exception riêng cho từng platform. Segment resume không được
backdate tool về trước root mới chỉ vì record giữ startedAt từ trước suspension.
Không đổi record duration sang phép trừ wall-clock: active duration hiện loại
thời gian chờ suspend và dùng đồng hồ monotonic.

## C05 — Cùng event name nhưng có hai đường delivery

Nguồn: [hooks.ts](../packages/core/src/engine/hooks.ts:43),
[execution.ts](../packages/core/src/engine/execution.ts:295),
[agent.ts](../packages/core/src/agent.ts:381),
[delivery.ts](../packages/core/src/engine/delivery.ts:149).

Execution notifications thông thường đi qua plugin dispatch rồi Stream sink.
Một số `stream.error` đi thẳng vào sink; lỗi buffer của consumer cũng được tạo
trong delivery. Đăng ký `tessar.hook("stream.error", ...)` vì vậy không quan sát
được tất cả event mà iterator/subscriber nhận.

Tái hiện: chạy xong Stream có ID cố định, đợi cleanup, dùng lại ID đó. Iterator
nhận `RegistrationConflict`, hook `stream.error` nhận 0 event. Diagnostic vẫn có
thể được phát, nhưng không phải contract của hook `stream.error`.

Hướng thống nhất: xác định rõ notification của runtime và lỗi của attachment.
Nếu cùng một event contract thì cần đường publication chung; nếu khác ý nghĩa,
phải phân biệt contract, không chỉ tình cờ dùng cùng string. Giữ bảo vệ tránh
diagnostic recursion và không biến observer thành policy hook.

## C06 — Lifecycle Controller và Session không khép kín

Nguồn: [controller.ts](../packages/core/src/controller.ts:361),
[session.ts](../packages/core/src/session.ts:99),
[session disposal](../packages/core/src/session.ts:785).

Sau `await controller.dispose()` với Session còn sống:

```text
controller.isReady()       false
session.isDisposed()       false
session.state.get().status idle
await session.dispose()    throws Disposed
```

Controller đóng Agent/plugin/backend rồi chỉ clear Set các Session. Session
không cập nhật closed state, không đi qua cleanup observers/queue của nó, và sau
đó public dispose lại đòi Controller ready.

Hướng thống nhất: chốt ownership đóng resource theo cây Controller → Session.
Session handle phải phản ánh parent đã đóng, có cleanup kết thúc và disposal
idempotent; không giữ một handle báo sống nhưng không còn dispose được.

## C07 — Timestamp của event phụ thuộc nơi tạo

Nguồn: [event envelope](../packages/core/src/events/definition.ts:47),
[engine context](../packages/core/src/engine/hooks.ts:17),
[thread operations](../packages/core/src/state/thread-operations.ts:46),
[Controller ready](../packages/core/src/controller.ts:200).

Execution context và Session notifications có timestamp. `ready` và
`thread.started` trong thử nghiệm trực tiếp không có timestamp. EventEnvelope
chỉ copy giá trị caller cung cấp. Logger tự bổ sung thời gian khi ghi, còn
tracing có fallback khác.

Ảnh hưởng: hai plugin có thể gán hai thời điểm quan sát khác nhau cho cùng một
notification; không thể mặc định `event.timestamp` luôn là mốc phát của Tessar.

Hướng thống nhất: Core cấp thời gian tại boundary phát event bằng cùng Clock;
consumer không tự tái tạo timestamp. Sequence cũng cần được mô tả theo phạm vi
phát, không suy ra là một thứ tự toàn cục chỉ từ tên field.

## C08 — Tool key chưa làm alias

Nguồn: [Agent constructor](../packages/core/src/agent.ts:175),
[API review](api-review.md:698).

`tools: { search_web: searchTool }` vẫn đăng ký `searchTool.name`, vì constructor
chỉ lấy `Object.values()`. Hai alias cho cùng Tool cũng bị coi là trùng tên.
API review đã ghi nhận khoảng trống này; ghi vào docs chưa thay cho triển khai
hành vi alias đã bàn.

Hướng thống nhất: chốt object key có phải tên đăng ký hay không rồi dùng cùng
quy tắc ở selection, registry, provider descriptions, tool dispatch và history.
Nếu dùng alias, giữ nguyên Tool instance gốc khi tái sử dụng ở Agent khác.

## C09 — OpenAI built-in có hai cách tạo provider khác khả năng

Nguồn: [plugin.ts](../packages/openai/src/plugin.ts:7),
[provider.ts](../packages/openai/src/provider.ts:80),
[API review](api-review.md:702).

`OpenAIProvider` chọn Responses/Chat Completions và nhận native request options.
`OpenAIPlugin` chỉ nhận OpenAIOptions và tạo OpenAIAdapter trực tiếp, tức đường
Responses; không dùng cùng provider constructor. Vì vậy chuyển từ cấu hình
trong app sang provider được cài qua plugin không chỉ là đổi nơi đăng ký.

Hướng thống nhất: dùng chung contract/cách tạo executable provider, giữ registration
ở plugin. Không viết lại protocol và validation riêng cho từng entrypoint.
Đây là kết luận từ code/types; chưa chạy HTTP riêng cho finding này.

## Phần đã đối chiếu và không coi là lỗi đồng nhất

- Các storage plugin cùng implement Plugin/setup và cùng đăng ký một
  StorageBackend contract. Cách index, transaction, connection options và schema
  vật lý khác nhau theo DB là cần thiết. PostgreSQL/MongoDB chưa được xác minh
  trực tiếp với server DB trong lượt rà này.
- Session model/thread APIs nằm ở Session; Controller quản lý lifecycle, plugin
  và tạo/khôi phục Session. Không thấy public Controller.models hoặc các public
  Controller.createThread/getThread cũ trong declaration đã build.
- `scope()`, `metadata()`, `profile()` là runtime methods; field cùng tên trong
  DTO là dữ liệu, không phải một API bị quên chuyển thành method.
- Root package entrypoints tách implementation; OpenAIAdapter không được export
  từ root. OpenAIAPI hiện là public union cấu hình protocol, khác adapter nội bộ.
- Tracing adapters dùng snapshot độc lập để map dữ liệu platform. Khác cách
  Langfuse/OpenInference/OpenLLMetry hiển thị không tự nó là lỗi Core contract.

## Kiểm chứng và hướng xử lý

Đã build workspace, typecheck source/tests và kiểm tra dependency boundaries.
388 package tests passed, 39 skipped; 43 integration tests passed. Các probe
đối chiếu hành vi nằm trong `.superpowers/audit-consistency.mjs`; kết quả máy đọc
được ở `.superpowers/audit-consistency-result.json`. Không có provider HTTP,
dashboard hay PostgreSQL/MongoDB server thật trong các probe này.

Các thay đổi timing/root trước khi bắt đầu audit được giữ nguyên; audit này
không tự sửa hàng loạt các finding. Root hierarchy đã có regression coverage
cho follow-up, restart, resume và recovery; timing consumer còn dở như C04.

Ưu tiên: chốt và sửa C01–C04 trước, sau đó C05–C09. Mỗi thay đổi contract cần
được đối chiếu tối thiểu giữa Agent trực tiếp, Session, capability đăng ký qua
plugin và restart/resume khi liên quan. Dùng các phép thử này làm regression
tests trong package hiện có; không cần thêm một framework audit mới.

Tài liệu cũng cần một nguồn contract hiện hành rõ ràng: architecture-notes còn
giữ quyết định cũ dưới phần ghi chú lịch sử, còn api-review ghi nhận implementation
và các điểm chưa nghiệm thu. Chỉ cập nhật một spec/README rồi để contract test
và các consumer cũ khác đi là nguyên nhân khiến kiểu lệch này tái diễn.

## Kết quả sửa và kiểm chứng — 2026-10-25

| Mã | Thay đổi đã triển khai | Regression chính (trong packages/) |
| --- | --- | --- |
| C01 | Tool đăng ký qua Agent và plugin đều giữ schema identity; không bỏ compatibility guard khi resume | `core/test/engine/plugin-continuity.test.ts` |
| C02 | Session giữ executable named connections trong runtime; restore/switch/continuation dùng đúng adapter; detach xóa cache và ID không được trỏ sang descriptor khác | `openai/test/provider.test.ts`, `core/test/models/registry.test.ts` |
| C03 | Boundary đăng ký storage gắn provenance cho toàn bộ ports và cleanup close; giữ exception gốc, hỗ trợ frozen ports | `core/test/errors.test.ts` |
| C04 | Tracing dùng chung record timing cho Stream/Turn/model/tool; segment resume có parent mới và không có duration âm | `opentelemetry/test/index.test.ts` |
| C05 | Runtime và consumer errors đều tới hooks; target phân biệt execution/consumer, overflow không dừng Agent, async hook giữ lease đến khi xong | `core/test/engine/delivery.test.ts` |
| C06 | Controller dispose đóng Session handles/queues, phát closed trước plugin cleanup; public close vẫn có thể bị barrier từ chối | `core/test/controller.test.ts` |
| C07 | Event được đóng timestamp một lần tại publication boundary; Logger dùng timestamp đó | `core/test/events/string-events.test.ts` |
| C08 | Agent tool object keys là alias xuyên suốt description, dispatch và history; Tool gốc không mutate | `core/test/tools/agent-tools.test.ts` |
| C09 | OpenAIPlugin dùng OpenAIProvider, hỗ trợ cả hai protocol và native options, chia sẻ lazy client/connection | `openai/test/provider.test.ts` |

Các đường Agent và Session dùng cùng generic option ownership guard; validation
riêng của provider ở adapter. Agent dùng ModelRef cũng nhận JSON modelOptions
trong TypeScript, còn executable provider giữ type options riêng. Generic fields
thuộc runtime bị từ chối trước admission; cấu hình riêng OpenAI không hỗ trợ
thất bại ở provider validation, không gửi HTTP request.

Langfuse dùng trace riêng cho mỗi invocation/followUp, Agent root → Turn → model
và tool; Langfuse Session nhóm theo Tessar Thread ID. Resume/recover tạo segment
mới, giữ logical IDs và Turn numbering. Auxiliary call sau Turn đã đóng nằm dưới
Agent root, không sinh Turn giả. `realtime` optional, mặc định false; true dùng
native SimpleSpanProcessor để gửi span đã kết thúc, không gửi token hay span đang chạy.

Kiểm chứng sau sửa trên Windows, Node.js 24.22.1:

- Source/test typecheck, workspace build, dependency boundaries và `git diff --check` đều qua.
- 405 package tests passed, 39 skipped; 43 integration tests passed.
- Kiểm thử Langfuse Cloud qua HTTP API nhận hai trace, lần lượt 9 và 3 observations,
  cùng Thread group, System prompt, model output, tool description/schema và thời gian hợp lệ.
  Generation xuất hiện khi tool vẫn đang chờ, trước khi Agent root kết thúc.
- Test Cloud dùng scripted model/tool để kiểm tra ingestion và hierarchy; không gọi
  provider thật. Không kiểm tra dashboard bằng browser hoặc server PostgreSQL/MongoDB
  trong lượt này; các test DB bị skip không xác minh backend thật.

Giới hạn compatibility: stored state không chứa executable client/credentials;
restart phải tái đăng ký named connection có cùng descriptor. Thay schema của tool
đang suspend có thể làm continuation bị từ chối, kể cả manifest plugin cũ thiếu schema
identity. Không đổi DB schema hoặc thêm migration để bỏ qua các guard này.

Public reference đã đồng bộ tại [api-review.md](api-review.md), cùng các guide
[tools](../examples/guide/tools.md), [Stream](../examples/guide/stream.md),
[Session](../examples/guide/sessions.md) và [tracing](../examples/guide/opentelemetry.md).
