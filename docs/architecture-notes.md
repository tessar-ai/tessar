# Ghi chú định hướng Tessar

Current public contract: [API reference](api-review.md) and
[developer guides](../examples/guide/README.md), checked against public declarations
and regression tests. The [initial English spec](superpowers/specs/2026-10-15-tessar-minimal-core-design.md)
and [initial plan](superpowers/plans/2026-10-15-tessar-minimal-core-plan.md) record earlier decisions;
historical notes below do not override the current API.
TD-001 is now addressed for Node/npm hosts by
[the distribution spec](superpowers/specs/2026-10-15-plugin-distribution-design.md)
and [plan](superpowers/plans/2026-10-15-plugin-distribution-plan.md).
The implementation is now present. Earlier implementation-status statements below
are historical notes, not the current status.

Ngày ghi nhận: 2026-10-14.

## Cập nhật 2026-10-27: hoàn thiện hook contract

Đã triển khai trong checkout, chưa khẳng định đã phát hành trên npm:

- Lifecycle riêng `text.start/delta/end`, `reasoning.start/delta/end`,
  `tool.call.start/end`; bỏ message.delta, không có tool.call.delta hay alias.
  Adapter và runtime giữ một logical message ID, part identity/order và đóng
  part đang mở khi lỗi/hủy/consumer ngừng đọc. Primary và auxiliary dùng chung
  boundary kiểm tra và publish; UI chính không nhận draft của auxiliary.
- `currentMessage.content` là projection ở RAM có status từng part. Không có
  currentParts, không lưu UI status vào checkpoint, provider payload hoặc metadata.
- `context.prepare` xử lý context/tools của loop Agent. `provider.request` sửa
  native body sau adapter cho cả primary và auxiliary. Không sửa connection,
  credentials, model hoặc streaming. SDK retry giữ body đã chuẩn bị.
- Decision có type và validation theo boundary; invalid resumed decision giữ
  interruption pending. ControlDecision chỉ là union, không phải mọi boundary
  đều nhận mọi member. Notification không đổi kết quả execution đã commit.
- Bỏ thread.updated, tools.select, notification Session trùng thao tác Thread và
  barrier message.beforeCommit/stream.beforeEnd/session.beforeClose cùng lifecycle
  Thread handle. Notification Thread được phát sau khi Session cập nhật selection.
  Giữ policy gate trước fork/rename/delete/model switch/thread switch.
- Plugin state view không expose snapshots(). `turn.start` có state context để
  plugin cập nhật state lifecycle; checkpoint observers không có mutable services.
- `ctx.models.stream(request)` nhận một ModelRequest; model chỉ khai báo một lần,
  purpose auxiliary do runtime xác định. Helper không tự chạy context.prepare.
- Session.model có get/name/info/list/switch/setEffort. Info là snapshot model đang
  dùng và native options. Effort mapping thuộc adapter, không có effort state riêng.
  Model/connection đổi phát modelChanged; options đổi phát model.optionsChanged sau
  persistence. Per-stream override không thay cấu hình Session.
- Session.isIdle() nghĩa là không chạy và không có input xếp hàng. Suspended không
  có queue là idle; không cung cấp running() trùng nghĩa.

Subagent vẫn do plugin tự ghép Agent, tool và context; cùng process hay process
riêng do plugin chọn. Agent mới không tự kế thừa Controller/hook/tool/history.
Controller chỉ cần khi Agent con dùng plugins; Session tùy nhu cầu persistence.
Không có API chuyên subagent, tool lồng, signal transport hay client SDK trong đợt này.
Không có migration/compatibility aliases, dependency hoặc DB schema mới.

Tra contract và parameter hiện tại tại [API reference](api-review.md) và
[plugin hooks](plugin-api-and-events.md). Các ghi chú cũ bên dưới là lịch sử.

## Cập nhật 2026-10-15: ponytail áp dụng từ đầu

Áp dụng ponytail (full) cho toàn bộ thiết kế, plan và code đã viết, kể cả
những task đã đánh dấu hoàn thành. Không chỉ áp dụng cho phần viết tiếp.
Các yêu cầu người dùng đã chốt vẫn giữ nguyên; cách triển khai phải được
xét lại nếu thêm tầng, class, interface hoặc file mà chưa có nhu cầu thực tế.

Ưu tiên tái sử dụng code hiện có, thư viện chuẩn và dependency đã cài.
Không viết lại toàn bộ hoặc chia nhỏ file chỉ để giảm số dòng mỗi file.
Agent loop phải thể hiện rõ luồng turn → model → tools → tiếp tục/dừng;
phần hỗ trợ chỉ tách khi có trách nhiệm và dependency rõ ràng.
Theo yêu cầu tiếp theo, `packages/core/src/loop.ts` chứa vòng turn và các bước
gọi model/tool, dùng chung cho input mới, resume và recovery. Agent vẫn sở hữu
admission, checkpoint, interrupt và finalization; API công khai giữ nguyên.
Giữ storage/checkpoint, validation và các bảo đảm chống mất dữ liệu đã chốt.

Cập nhật 2026-10-16: Agent giữ cấu hình, public API và quản lý tác vụ đang chạy.
Các function nội bộ cho execution/cancel, hook/suspend, checkpoint/message,
tracked services và resume/recovery nằm trong `core/src/engine/` theo trách nhiệm.
Input, resume và recovery dùng chung dựng frame và nạp record. Loop vẫn là
function trong `loop.ts`; API công khai giữ nguyên. Chi tiết và kết quả kiểm tra:
[Agent refactor](superpowers/plans/2026-10-16-tessar-agent-refactor.md).

## Core và SDK: package chính đã chốt

`@tessar/core` cung cấp trực tiếp `Agent`, `Controller`, `Session`,
`Thread`, message constructors, `createTool`, instructions và plugin APIs.
Dev cài package chính và import các API này từ `@tessar/core`;
Session thường được tạo qua `controller.createSession()`.

Core là phần thực thi nền tảng; SDK là bộ API công khai để sử dụng và mở
rộng nền tảng đó. Không tách thành package `@tessar/sdk` hoặc tạo
SDK runtime/RuntimePort chỉ để nối Agent với Controller/Session.
Agent trực tiếp sở hữu loop; Controller sở hữu lifecycle/resources và Session
tương tác với cùng Agent. Không thêm class engine để Agent gọi qua.
Provider protocol/credentials và các storage adapters nằm trong packages
plugin riêng; memory storage mặc định có sẵn trong core.
Provider OpenAI dùng package `@tessar/openai` trong `packages/openai`.

Đây là contract mới để sửa source/plan hiện có; chưa phải bằng chứng các
exports đã được implement hoặc package đã publish lên npm.

## Lưu ý quan trọng: độc lập với Cube

Tessar là framework và SDK độc lập. Thiết kế của Tessar không được lấy
kiến trúc hiện tại, tính năng hay các yêu cầu riêng của Cube làm khuôn mẫu.

Mục tiêu là xây dựng một hệ sinh thái dùng chung cho các ứng dụng agent.
Cube là một ứng dụng sử dụng framework, SDK và các plugin trong hệ sinh thái đó.
Các nhu cầu riêng của Cube thuộc về ứng dụng hoặc plugin của Cube; chúng không
mặc nhiên trở thành trách nhiệm của core Tessar.

## Người sử dụng và mục đích

Framework hướng tới những người muốn tự xây agent chạy trong CLI của họ,
hoặc tích hợp agent vào application của họ. Cả hai cách sử dụng phải dựa trên
cùng một nền tảng thực thi và hệ sinh thái plugin. CLI không phải là điều kiện
để sử dụng SDK; ứng dụng tự sở hữu giao diện và cách tương tác với người dùng.

Backend tự tích hợp SDK vào ứng dụng của họ và tự quản lý transport,
authentication, request lifecycle và cách vận hành.

## API nền theo class

API nền của core là `new Agent(...)`. Các API cấp cao trong hệ sinh thái,
ví dụ `createCodingAgent(...)`, cấu hình và ghép các khả năng trên cùng lõi
`Agent`; chúng không tạo một engine hoặc agent loop riêng.

Việc bổ sung loại agent mới không mặc nhiên đưa các tính năng chuyên biệt
của loại agent đó vào core.

SDK cũng phải cung cấp các API dữ liệu nền tảng dạng class, ví dụ
`new HumanMessage(...)` và `new SystemMessage(...)`. Người sử dụng xây dựng
messages bằng các primitives công khai, không phải biết payload riêng của
từng provider hoặc phụ thuộc một framework khác để tạo message.

## Controller sở hữu runtime, Session là API tương tác

Đã chốt sau review ngày 2026-10-15: Controller sở hữu initialization/runtime,
storage backend, registry và plugin resources. Agent giữ định nghĩa hành vi,
instructions/model/limits và agent loop, dùng cùng core execution contracts.
Đã cập nhật ngày 2026-10-16: khai báo plugins trên Controller, cùng nơi sở hữu
setup/attach/detach/cleanup; Agent không còn nhận hoặc giữ danh sách plugins.

Phân phối plugin ngoài được cập nhật ngày 2026-10-16: thư mục root do CLI chọn
(ví dụ `.my-cli`), custom ở `plugins/` được tự nhận diện, danh sách package ở
`plugins.json` dưới key `packages`. npm quản lý `npm/package.json`, lockfile và
`npm/node_modules`. `PluginManager` cung cấp install/load/update/remove; Tessar
không bắt CLI dùng tên lệnh hoặc tên thư mục cố định. File custom có thể đứng riêng
hoặc nằm trong thư mục có index; cả hai default-export instance plugin tạo bằng new.

- Dùng new Agent({id,...}), new Controller({id,agent,plugins}), await controller.initialize().
  Không yêu cầu thêm agent.initialize hoặc session.initialize public.
- controller.createSession({model,scope}) tạo Session dùng runtime đã ready.
- Session có subscribe (mọi events hoặc typed definition), stream, abort,
  followUp và nhóm session.thread để quản lý/chọn hội thoại.
- session.thread có create/select/get/getId/list/rename/fork/delete/getHistory.
  Các thao tác trên Thread hiện tại không bắt application truyền thread lặp
  lại cho mỗi stream. Direct Thread/Controller APIs vẫn có cho plugin authors.
- subscribe là observation, không thay policy hooks; abort không xóa history.
  followUp là input chờ lượt xử lý kế tiếp, không phải final model output.

Đây là quyết định thay thế hướng Agent sở hữu public initialize/lifecycle
trước đó. Chi tiết signatures/defaults theo bản public API/state machine.
agent.generate đang được đề xuất như convenience một lần nhận output từ
cùng engine, không yêu cầu Session; không suy ra chỉ một model call hoặc
bỏ state/trace/checkpoint. Semantics của helper này đang được review riêng.

## ID khi tạo Agent và Controller

Đã chốt: Agent và Controller bắt buộc nhận id do dev tự định danh, ví dụ
new Agent({id:"assistant", ...}) và new Controller({id:"main", agent}).
SDK không tự generate ID cho hai thành phần này; factories giữ ID caller cấp.

Session không cần id public hoặc id trong createSession; application chỉ
truyền scope cho phần state như đã thống nhất. Scope vẫn là metadata filter,
không là primary identity; Sessions cùng scope không bị gộp thành một phiên.
Các IDs nội bộ của Thread/Stream/checkpoint/messages theo contracts trước đó,
không yêu cầu dev tự điền mọi execution record ID.

## Instructions và buildInstruction

Instructions nền thuộc Agent. Thread có thể bổ sung instructions cho hội
thoại; Session giữ model selection, scope và preferences. SDK có helper
buildInstruction để ghép các sections có identity/thứ tự, trả Instruction
bất biến; Agent.instructions vẫn nhận string cho trường hợp đơn giản.

Core giữ cấu trúc/composition và snapshot cho execution; application/plugin
cung cấp nội dung. Thread additions không âm thầm xóa Agent base; plugin
thay section qua explicit context transformation. Helper không I/O, không
tự tải file hoặc hardcode schema nghiệp vụ của một loại agent.

## Model providers qua plugin, SDK cung cấp công cụ sẵn

Provider integration theo hướng plugin. Core sở hữu ModelAdapter/ModelProvider
contracts, registry, agent loop và normalized events/usage. SDK cung cấp các
adapters, provider helpers và registration APIs để dev tự viết provider plugin.

Các helpers OpenAI/Anthropic/Google có thể được cung cấp sẵn trong SDK modules,
nhưng không tự gắn vào Agent hoặc làm engine phụ thuộc một provider cố định.
Một CLI đóng gói có thể ship các provider plugins mặc định rồi load thêm plugin
qua cùng public contracts. Dev không phải tự viết lại giao thức của từng hãng.

Lượt thực thi agent được biểu diễn bằng `Stream`, với API
`thread.stream(...)`, `StreamContext` và lifecycle events thuộc nhóm
`stream_*`. Stream phát các updates trong quá trình model/tools hoạt động;
kết quả tổng hợp cuối là thông tin hoàn tất của cùng stream.

## Model profile do SDK tự lấy

Đã chốt ngày 2026-10-15: dev lấy/chọn một model và đọc `model.profile` để
nhận thông tin của model đó. SDK tự resolve metadata; không bắt dev tạo
`new ModelProfile(...)`, tự điền thông số hoặc duy trì catalog riêng.

- Profile mô tả model: identity/display name, context window, giới hạn
  output, capabilities/modalities và pricing khi nguồn metadata có cung cấp.
  Đây không phải API profile chứa endpoint/credentials hoặc request options.
- SDK cung cấp metadata resolution qua provider helpers/adapters, dùng
  catalog hoặc API metadata phù hợp. Core định nghĩa profile contract,
  chuẩn hóa/validate và cung cấp cùng dữ liệu cho engine, host và plugins.
- Provider integration vẫn qua plugin; SDK helpers đảm nhiệm việc lấy
  profile khi tích hợp theo contracts chuẩn. Không chuyển trách nhiệm tự
  điền thông tin từng model sang application hoặc tác giả plugin dùng helpers.
- Dữ liệu không có nguồn đáng tin cậy phải biểu diễn là chưa biết; không
  suy đoán, mặc định thành false/0 hoặc buộc dev nhập tay để có model object.

Nguồn catalog/API cụ thể, thời điểm resolve, refresh/cache và biểu diễn
partial/unavailable còn cần chốt. `model.profile` là yêu cầu API đã xác nhận,
chưa phải khả năng đã được implement.

## Thread và session

Thread là một hội thoại bền vững, sở hữu messages và state. Core cung cấp
Agent, Thread và Stream. Session là khái niệm của host/SDK tùy chọn: một
phiên CLI có thể mở nhiều threads; backend có thể làm việc trực tiếp với
Agent/Thread/Stream mà không cần xác định một lần chạy chương trình là session.

Với CLI multi-model, Session sở hữu model đang chọn và các lựa chọn thực thi
của phiên. Thread sở hữu lịch sử hội thoại; lựa chọn model hiện tại không
được mặc nhiên gắn cố định vào thread. Stream chụp lựa chọn của Session khi
bắt đầu để việc đổi model không làm thay đổi execution đang chạy.

Backend có thể tạo Session qua Controller theo vòng đời application hoặc
truyền model selection tường minh khi bắt đầu execution ở cấp thấp hơn.
Không dùng một lựa chọn mutable toàn cục của Agent/Controller cho mọi người dùng.

SessionEvents ở lớp SDK dùng chung typed dispatcher với plugin API. Không
bắt Session có public ID; context mang scope và controller/agent/thread/stream
IDs khi liên quan, subscription gắn với Session instance trong runtime.
Controller initialize một lần trước các Sessions để đăng ký handlers/tài nguyên;
không thêm session.initialize. Danh sách events, queue và close semantics
cụ thể là đề xuất review trong bản public API/state machine mục 5.5.

## Scope chỉ áp dụng cho state

Agent, engine, plugin/provider definitions và registries là runtime dùng
chung. Scope là plain-object metadata gắn với state để application filter,
ví dụ `{ userId, workspaceId }`. Không cần `new StateScope()` hoặc một
runtime/DI scope riêng. Application tự định nghĩa các fields và quyền truy cập.

Thread history, Session model selection/preferences, execution records và
plugin state mang scope metadata khi cần phân biệt dữ liệu. Session nhận
scope mặc định một lần, dùng khi list/get/create/fork thread. Thread state
lưu metadata thực tế; Session không trở thành chủ sở hữu vĩnh viễn của thread.

Scope của dữ liệu và lifecycle owner là hai chiều khác nhau. Ví dụ plugin
state có scope metadata của user và ownerType/ownerId của thread. Runtime
không phải được tạo lại khi application thay đổi filters.

API Session hiện tại nhóm các thao tác dưới session.thread:
create/select/get/getId/list/rename/fork/delete/getHistory. Tác giả plugin có
thể dùng các state APIs thấp hơn qua public SDK với scope
tường minh. Plugin tự quyết định scope, context và quan hệ giữa các Agent;
core không có protocol reserve/admit cho subagent. parentThreadId và
sourceCheckpointId của Thread chỉ mô tả nguồn khi fork Thread.

session.thread.getHistory đọc canonical messages đã commit theo Thread/
checkpoint, có phân trang; Session áp scope mặc định, Thread cung cấp cùng
API cho SDK/plugin.
Đây là history hội thoại, tách khỏi execution trace và model context projection.

## Thực thi đồng thời và hủy Stream

Quy tắc đã chốt ngày 2026-10-15:

- Một Thread chỉ có một Stream hoạt động tại một thời điểm. Gọi thêm trả
  lỗi `ThreadBusy`; core không tự xếp hàng. Application hoặc plugin có thể
  bổ sung queue.
- Các Threads khác nhau có thể chạy đồng thời trên cùng Agent. Subagent
  sử dụng Thread riêng.
- Hủy qua AbortSignal: core ngừng lên lịch công việc mới và truyền tín hiệu
  tới model, tools và hooks. Plugin/tool phải hỗ trợ hủy; cancellation
  không hoàn tác tác động đã xảy ra.
- Ngừng đọc events hoặc client mất kết nối không mặc nhiên hủy Stream.
  Host quyết định có gửi tín hiệu hủy hay tiếp tục execution.

## Storage là chức năng có sẵn; plugin chỉ chọn backend

Ranh giới đã được người dùng nhấn mạnh ngày 2026-10-15: Tessar cung cấp
sẵn toàn bộ chức năng storage/state management, không chờ plugin bổ sung
khả năng lưu state.

- Core quản lý logical schema, state mutations/revisions, commit boundaries,
  checkpoint, serialize/restore, query/filter và fork theo public contracts.
- Storage backend plugin chỉ triển khai nơi lưu dữ liệu: SQLite, PostgreSQL,
  MongoDB, file hoặc backend của application. Plugin thực hiện I/O và các
  primitives nhất quán mà core yêu cầu; không tự định nghĩa lifecycle lưu
  state, checkpoint hay cách khôi phục Thread.
- Backend trong bộ nhớ có sẵn mặc định. Không đăng ký backend khác thì vẫn
  dùng cùng chức năng storage; dữ liệu trong bộ nhớ không tồn tại qua restart.
- Storage nằm trong đường commit của core, không được ghép bằng event
  observers để tạo ra tính năng persistence. Application thao tác qua SDK/
  Session; backend plugin thực hiện contracts phía sau.

Checkpoint schema, failure policy và signatures cụ thể vẫn cần chốt. Ranh
giới trách nhiệm core/backend ở trên là quyết định đã xác nhận.

## Checkpoint, suspend/resume và recovery thuộc core

Đã chốt ngày 2026-10-15: core thiết kế checkpoint cùng suspend/resume và
recovery tại các boundary xác định ngay từ đầu. Phạm vi không chỉ là đọc
lại history hoặc fork; cơ chế thực thi phải tiếp tục được từ state đã lưu
khi đáp ứng contract recovery.

- HITL: core lưu trạng thái suspended, vị trí execution và yêu cầu đang chờ;
  nhận/validate phản hồi đúng yêu cầu, ngăn phản hồi bị áp dụng trùng và
  tiếp tục execution. Plugin quyết định khi nào cần hỏi; host hiển thị/nhận
  câu trả lời. Không dùng Promise đang chờ làm trạng thái durable.
- Fault tolerance: core ghi nhận bước đã hoàn tất, nhận diện bước gián đoạn,
  quản lý quyền resume và tiếp tục theo recovery contract. Không chạy lại
  bước đã hoàn tất được ghi nhận chỉ vì một process vừa restart.
- Tool có tác động bên ngoài cần idempotency hoặc reconciliation khi kết quả
  chưa xác định sau crash. Checkpoint không tự bảo đảm exactly-once cho
  hệ thống bên ngoài; không replay tool một cách mù quáng.
- Backend plugin chỉ cung cấp nơi lưu và consistency primitives. Khả năng
  tiếp tục qua restart cần backend lưu bền vững; memory backend có cùng
  APIs nhưng không giữ dữ liệu sau khi process kết thúc.

Lifecycle suspend/resume đã chốt:

- Core lưu checkpoint cùng pending request trước khi chuyển sang suspended
  và phát StreamSuspended; lượt đọc events hiện tại kết thúc tại đó.
- Suspended chưa kết thúc logical execution. Không buộc host giữ connection
  hoặc Promise chờ phản hồi; execution có thể được resume sau restart khi
  state được lưu bền vững.
- Resume dùng interruptId và phản hồi qua API streaming, giữ nguyên streamId
  của execution và trả Stream handle mới để tiêu thụ events. Không cộng lại
  usage cũ hoặc chạy lại các bước đã ghi nhận hoàn tất.
- Trước khi tiếp tục, core kiểm tra checkpoint, quyền thực thi và capabilities
  cần cho bước tiếp theo. Completed/failed/cancelled/stopped là terminal outcomes;
  kết thúc lượt đọc events do suspend không phải terminal outcome.

Đổi model khi resume đã chốt:

- Checkpoint/trace ghi model đã dùng, không khóa model cho các lời gọi sau.
  Resume mặc định giữ selection trước đó; dev được đổi model tường minh.
  Session đổi current model không tự sửa execution đang chạy hoặc history.
- Đổi model áp dụng cho model request tiếp theo tại boundary hợp lệ. Không
  ghép token đang sinh của attempt cũ với model mới; nếu thay attempt dang
  dở phải kết thúc attempt cũ và tạo attempt mới, ghi trace/usage riêng.
- Core kiểm tra compatibility của messages, tool definitions và provider
  state khi chuẩn bị request mới. Adapter/context pipeline xử lý chuyển đổi;
  không cấm toàn bộ resume chỉ vì model khác model đã ghi trong checkpoint.
- Kiểm tra tool call đã được duyệt giữ đúng nội dung là yêu cầu riêng;
  đổi model không tự thay payload hoặc quyền thực thi của tool call đó.

Interrupt records, signatures chi tiết, ownership, plugin/resource lifecycle
qua suspension và recovery decisions vẫn cần review.

## Execution trace và usage là dữ liệu nền tảng

State phải ghi nhận từng turn, các model attempts và tool executions, cùng
tokens, cache usage, timing, status và errors khi có. Usage được ghi ở từng
model attempt rồi tổng hợp lên turn/stream/thread với quy tắc tránh đếm trùng.

Core tạo execution records, chuẩn hóa usage theo model contract và quản lý
lưu/khôi phục dữ liệu qua storage có sẵn. Backend plugin chỉ chọn nơi lưu;
telemetry plugin như Langfuse export dữ liệu ra hệ thống bên ngoài. Khả năng
biết execution history và usage không phụ thuộc việc cài telemetry plugin.

Provider không báo một usage metric thì giữ trạng thái chưa biết; không coi
thiếu dữ liệu là số 0. Schema phải phân biệt token tổng và các thành phần
cache/reasoning, tránh cộng lại các thành phần đã nằm trong tổng.

Reasoning/thinking là phần của assistant message và model contract. SDK
giữ content parts có kiểu cùng provider state/signatures cần cho continuity;
provider adapter xử lý protocol và compatibility. Context plugins cần tôn
trọng các đơn vị dữ liệu mà adapter yêu cầu giữ nguyên.

## Event API dễ khám phá

Event name là string ở runtime. SDK cung cấp constants và type map để có
autocomplete, suy luận payload/context/result khi viết plugin. Constants
trỏ tới chính string đó; không tạo object/class đại diện riêng cho mỗi event.

Ví dụ `api.on(AgentEvents.MessageDelta, handler)` và
`api.on("core.message.delta", handler)` dùng cùng một event và cùng type map.
Custom plugin events dùng cùng cơ chế, ví dụ `MemoryEvents.RecallEnd`.
Metadata điều phối hooks nằm trong registry; không biến event name thành
một runtime abstraction mới. Quyết định này thay hướng event definition
objects trong các bản thiết kế trước.

## Quan hệ với Mastra

Mục tiêu đối với Cube là chuyển sang sử dụng Tessar và không còn phụ thuộc
Mastra. Tessar tự sở hữu agent loop, không dùng Mastra làm lõi bên dưới.

Việc chuyển đổi Cube là công việc tích hợp của ứng dụng, không phải cơ sở để
thiết kế Tessar theo cấu trúc hoặc API của Mastra/Cube.

## Triết lý nền tảng

- “Everything is a plugin”: các khả năng mở rộng được cung cấp qua plugin.
- Extension points phải bao phủ các quyết định của execution, không chỉ
  đăng ký tools/providers và quan sát kết quả. Plugin cần typed events,
  interception contracts và public state/control APIs phù hợp.
- Core chỉ giữ những thành phần tối thiểu cần thiết để chạy một agent.
- Lấy cảm hứng từ pi.dev về core tối giản và khả năng mở rộng.
- Tessar tự xây dựng core độc lập, thay vì dùng lõi Pi hoặc Mastra.

## Lưu ý quan trọng: chỉ core là bắt buộc, mở rộng được bổ sung sau

Ý người dùng: “anything are plugin” chỉ cần có core; những phần khác có thể
tự thêm sau mà không ảnh hưởng core đang chạy. Pi CLI là một ví dụ về sản
phẩm đã được đóng gói nhưng vẫn mở rộng được bằng plugin.

- Core là nền tảng bắt buộc duy nhất. Các khả năng chuyên biệt được chọn và
  ghép vào qua contracts/plugin API, thay vì trở thành phụ thuộc bắt buộc
  của mọi ứng dụng.
- Plugin và integrations mới có thể được phát triển, bổ sung độc lập sau
  khi core đã tồn tại. Chúng không yêu cầu sửa engine hoặc làm gián đoạn
  hoạt động hiện có của core để thêm tính năng.
- Một CLI, application hoặc agent preset có thể đóng gói sẵn cấu hình và
  các plugin mặc định, đồng thời tiếp tục cung cấp điểm mở rộng công khai
  cho plugin của người dùng. Đóng gói thành sản phẩm không làm mất khả năng
  mở rộng của nền tảng.
- Tính năng mặc định của một sản phẩm vẫn thuộc lớp composition/plugin;
  chúng không mặc nhiên trở thành tính năng của core.

Quy tắc lifecycle đã chốt ngày 2026-10-15:

- Mỗi Stream giữ bộ plugin và registrations tại thời điểm bắt đầu, xuyên
  suốt các turns của Stream đó.
- Plugin được đăng ký thêm chỉ áp dụng cho Streams bắt đầu sau khi setup
  thành công và registrations được publish nguyên tử. Setup thất bại giữ
  nguyên bộ registrations đang hoạt động.
- Gỡ plugin ngừng cấp plugin đó cho Streams mới; Streams đang sử dụng nó
  tiếp tục với bộ đã giữ. Chỉ dispose tài nguyên plugin khi không còn
  execution sử dụng chúng.

Quy tắc này áp dụng cho tools, providers và event handlers do plugin đăng
ký. API signatures, plugin dependencies và cơ chế hot reload/package loading
vẫn cần thiết kế; chưa coi các cơ chế đó là khả năng đã triển khai.

## Nợ kỹ thuật TD-001: phân phối, cài đặt và nạp plugin

Ngày ghi nhận: 2026-10-15. Cập nhật: người dùng yêu cầu trả nợ; đã triển khai
`@tessar/plugins` cho Node/npm CLI. Phạm vi hoãn bên dưới là ghi nhận lịch sử.
Standalone executable cần kiểm chứng riêng theo runtime đóng gói được chọn.

Phạm vi để phase sau:

- Loader/discovery để CLI hoặc application đã đóng gói nhận plugin từ
  đường dẫn local hoặc package mà không cần sửa composition code của host.
- Công cụ cài/cập nhật/gỡ plugin từ npm/git và quản lý dependencies.
- Quy tắc module resolution, TypeScript/build và compatibility giữa SDK,
  host đóng gói và packages; cách dùng chung SDK mà không tạo instances
  classes/registries trùng ngoài ý muốn.

Phase hiện tại chỉ nhận plugin instances do application import/khởi tạo
và truyền qua public SDK. Plugin local không bắt buộc đóng thành npm package;
dependencies do project/application quản lý bằng công cụ sẵn có. Không xây
installer, package manager hoặc dynamic code loader trong phase này.

Làm rõ việc phân phối: CLI đóng gói/cài một lệnh mang theo dependencies của
chính CLI; người dùng cuối không cần cài lại core riêng. Nếu host hỗ trợ
plugin file tại root, file chỉ dùng API host truyền vào và không import
package ngoài thì không cần npm install thêm. Package mà file plugin import
phải có trong môi trường resolve của plugin; dependency mới có thể cần cài
local hoặc qua công cụ host. Scan/load root và cách cài dependencies thuộc
CLI/application, không phải hành vi tự động của core. TD-001 vẫn được hoãn.

Khoản nợ này không hoãn plugin contract, registration hay các quy tắc
attach/detach đã chốt. Không coi khả năng nhận plugin instances là bằng
chứng CLI binary đã hỗ trợ cài và nạp thêm plugin từ bên ngoài.

## Public API, state machine và implementation plan đã được yêu cầu

Ngày 2026-10-15 đã viết
[bản contract cụ thể](superpowers/specs/2026-10-15-tessar-public-api-state-machine-design.md)
cho Agent/Session/Thread/Stream, model.profile, checkpoint/interrupts, core
storage, HITL/recovery và fork. Bản này có ví dụ xuyên suốt và acceptance
matrix để chuẩn bị implementation plan.

[Implementation plan](superpowers/plans/2026-10-15-tessar-implementation-plan.md)
chia thành core/storage, durable engine và SDK/integrations, có acceptance tests
và thứ tự triển khai riêng. Chưa chạy các tasks trong plan.

Người dùng đã chốt và yêu cầu viết implementation plan ngày 2026-10-15.
Chưa có implementation; TD-001 vẫn ngoài phase hiện tại.

Quyết định cuối: Agent có model mặc định, generate/stream dùng cùng loop.
Session có subscribe/followUp/abort và resume/recover; không cần send/stream
public. Thread selection dùng session.thread.switch. Agent và Controller
phải có id dev định danh; Session không có id public. Storage/checkpoints
là trách nhiệm có sẵn; backend plugin chỉ chọn nơi lưu.

Skills, memory dài hạn, slash commands và subagents thuộc plugins. Dev chọn
nguồn skills/memory, hành vi command, process/remote/fork/fresh và scheduling/
reduction của subagents. Public hooks, state, trace, checkpoint và tracked
execution phải đủ để làm các việc đó mà không sửa core; không đưa policy
của các khả năng này vào engine. Durable orchestration vẫn cần plugin ghi
dispatch identity/outcomes và reconcile effects không rõ.
