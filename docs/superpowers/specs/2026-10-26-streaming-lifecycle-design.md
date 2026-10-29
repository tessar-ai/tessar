# Typed Streaming Lifecycles

Status: implemented in the working tree under hook-completion plan (2026-10-27). Earlier proposal language below records the design discussion; current public contracts are docs/api-review.md and docs/plugin-api-and-events.md.

## Agreed direction and proposed details

The user chose separate public lifecycles for text, reasoning, and tool-call
generation rather than a generic content-part lifecycle. Each extension point
must provide meaningful information or control; event count is not a target.

The user approved tool.call.start/end with identical event strings and explicitly
excluded tool.call.delta. Use no separate toolCall namespace. Other names,
payload details and API updates below are author proposals, not approved contracts.
This phase excludes effort settings, native HTTP
interception, nested tool invocation, other hook cleanup, and browser transport.

Subsequent snapshot decision: do not add currentParts. Put live part status in
currentMessage.content in the runtime UI projection. Part status is RAM-only,
is not persisted and is not sent to providers. Concrete view types remain part
of the draft below; existing execution-record status persistence is unchanged.

## Approaches considered

| Approach | Tradeoff | Decision |
| --- | --- | --- |
| Generic part lifecycle with a kind | Shared handling, but consumers branch on kind | Not selected |
| Separate lifecycles | Direct subscriptions and specific payloads; shared invariants must stay consistent | Selected by the user |

Share ordinary types/functions internally where useful. Add no dispatcher,
broker, storage table, class hierarchy, or dependency for these events.

## Public events

All eight events are notifications. Handler returns do not transform output,
authorize execution, or control the loop. Consumers narrow with event.type.

| Exported map | Event strings |
| --- | --- |
| text.start/delta/end | text.start, text.delta, text.end |
| reasoning.start/delta/end | reasoning.start, reasoning.delta, reasoning.end |
| tool.call.start/end | tool.call.start, tool.call.end |

Maps are autocomplete helpers for strings. Replace message.delta directly;
do not publish an alias stream with duplicate deltas.

Existing tool.start/update/end/error still describe actual execution. Ending a
tool-call part never invokes a tool. Final response, argument validation,
permission/approval and checkpoint boundaries remain in place.

## Change list for this phase

| Action | Current public contract | Proposed contract |
| --- | --- | --- |
| Replace | message.delta with partKind text | text.delta, plus text.start/end |
| Replace | message.delta with partKind reasoning | reasoning.delta, plus reasoning.start/end |
| Add | No public tool-call generation lifecycle | tool.call.start/end; no argument delta event |
| Keep | tool.prepare/before/start/update/end/error/result | Existing execution/policy responsibilities and identifiers |
| Keep | model.*, stream.*, turn.*, message.prepare/beforeCommit/committed, checkpoint.committed | No cleanup or rename of these contracts in the streaming change; provider.request has its own spec |
| Replace provider chunk variant | ModelChunk message-delta | The eight explicit lifecycle variants; retain usage/response |
| Extend snapshot | RuntimeState.currentMessage.content | Add UI-only status per part; no currentParts field or duplicated part content |

This phase adds eight event names and removes message.delta. It does not add an
effort event, remove operation gates, or merge duplicate Session/Thread events.
Those remain active work in the agreed broader direction, with their own
contract decisions; see architecture-notes.md rather than treating this phase
as the full plugin API redesign.

## Identity and order

Adapter part chunks carry messageId, partId and partIndex. Runtime dispatch adds
attemptId, purpose (primary/auxiliary), and parentToolExecutionId when present.
Existing Stream/Thread/Session/Controller envelope identity remains unchanged.

- Choose one logical messageId before the first part; use it for every part and
  response.message.id in that attempt. Provider item IDs identify parts, not
  additional assistant messages. Do not introduce another run/draft ID.
- Prefer a provider response ID available before output; otherwise an adapter
  may generate a message UUID. Keep native correlation in providerRequestId and
  providerState. Built-in adapters must follow the same contract.
- partId is stable within the message. partIndex is the zero-based ordinal of
  its first start in the observed stream, not an offset into final MessageData.
  Assign the next ordinal to a final-only part when it is revealed. Chat may
  retain its existing canonical final order (reasoning before text), even when
  arrival order differs. Final message replacement reconciles that difference;
  do not reorder persisted provider content just to match observation indexes.
- Start once, accept deltas while open, end once. Parts may interleave. An ended
  part cannot reopen; a later block has another partId.
- Output transforms may change content but cannot change logical message ID.
  The committed message replaces the draft; its full text is not another delta.

Validate these invariants at the shared model-stream boundary used by primary
and auxiliary calls, without a second independent event pipeline.

## Payloads

These describe event.payload. Every payload includes the identity/attempt fields
above. Start/end fields describe the part lifecycle, not model/tool execution.

| Event | Additional fields |
| --- | --- |
| text.start / reasoning.start | startedAt; boundary: provider or observed |
| text.delta / reasoning.delta | delta: string |
| text.end / reasoning.end | status: completed or interrupted; text: string; startedAt; endedAt; boundary |
| tool.call.start | startedAt; boundary; optional known-complete toolCallId/name |
| tool.call.end, completed | toolCallId; name; arguments: JsonObject; startedAt; endedAt; boundary |
| tool.call.end, interrupted | optional toolCallId/name; startedAt; endedAt; boundary; no partial arguments |

Once exposed as complete, a tool-call ID/name cannot change. Adapters with
fragmented IDs/names withhold them until complete; partId correlates start/end.
Adapters buffer fragmented argument text internally and expose complete parsed
arguments only at successful end. There is no public argument delta or partial
argument text in the UI snapshot. Newly known metadata can be reported at end.

End text replaces accumulated text. Interrupted text is partial, not an
authoritative answer. Parse/validate arguments as an object before completed
tool.call.end. Invalid/incomplete arguments fail the attempt and close open
parts as interrupted; never emit placeholder arguments to make partial JSON fit.

The finalized/transformed response remains authoritative for persisted history.
Part events are ephemeral observations, not individual DB commits or a log that
is replayed after process restart. MessageData/ContentPart storage schema stays.

## Boundary truth and termination

Boundary explains why a boundary is known: provider means an explicit protocol
boundary; observed means a documented adapter/runtime observation boundary.
startedAt/endedAt use Tessar's observation clock; envelope timestamp is publish
time. These fields do not measure the model's internal thinking time.

Responses maps explicit content/summary/function-call boundaries where present.
Chat Completions starts parts when observed. Without a protocol guarantee of
per-part completion, close remaining parts at response completion, marked
observed. First text does not prove reasoning ended.

A final-only part can start and end when the final response reveals it; emit its
value at end without inventing deltas. Empty parts may also have no deltas.

On error, abort, or early auxiliary consumer return, close still-open parts as
interrupted before finalizing the attempt record and before any existing
terminal notification. Completed parts stay completed. Do not commit an
unsuccessful attempt as a completed assistant message or execute partial tools.

Early auxiliary return must dispatch interrupted part ends even though the
caller has stopped reading chunks; cleanup cannot depend on that caller
draining synthetic chunks. If the final response chunk was received, the
attempt is successful even if the caller returns immediately afterwards. If
not, its record is interrupted. Under current model-hook conventions an early
return without an exception/response emits neither model.error nor successful
model.end; do not fabricate either. A unified terminal model hook is left to
the separately agreed hook-contract phase, not silently introduced here.

model.start precedes part events. On success, close parts before model.response,
message preparation/commit and model.end through the existing lifecycle. Retry
creates a new attempt with its own message and parts.

## Primary and auxiliary paths

Both paths publish the same lifecycle with purpose/attempt metadata. Auxiliary
callers also receive the normalized ModelChunks they consume; dispatch occurs
once, not once from that iterator and again from the main loop.

StateView excludes auxiliary parts from the main chat projection. Tracing can
observe them under the originating tool. Keep existing auxiliary request/response
policy; do not silently add primary context transforms to auxiliary calls.

Time-to-first-output uses the first non-empty text/reasoning delta.
Empty starts and final-only output do not establish a
first-token measurement. Preserve unknown/null when unobservable.

## Runtime snapshot

Keep canonical MessageData and finalized ContentPart storage/provider contracts.
Enrich the UI draft in RuntimeState.currentMessage.content with readonly status
(streaming/completed/interrupted) per live part. Do not add a parallel currentParts
array or mirror part content into a second location.

- Text/reasoning parts contain their observed text and status.
- At tool.call.start, the draft may contain a UI-only tool-call part with known
  toolCallId/name, status streaming and no arguments. At successful end it gains
  complete validated arguments and status completed. Interrupted calls contain
  no partial or placeholder arguments.
- UI draft parts retain the correlation needed to update the correct part.
  Do not copy every event-envelope field into the renderable content.

The currentMessage view therefore has a dedicated runtime draft type; do not
claim incomplete UI tool-call parts are canonical ContentParts. This is a
readonly data type, not a new message class or execution/storage subsystem.
RuntimeState.messages retains committed messages plus that same primary draft
as today; its public type must admit the draft view. Text/reasoning renderers
continue reading their live text through content. Code requiring canonical
MessageData uses finalized history/output, not an incomplete runtime draft.

On commit, replace the UI draft with the canonical committed message and set
currentMessage to null. On interruption retain the marked draft until the next
attempt/selection replaces it. A retry removes its predecessor's draft before
new output. Never commit these UI statuses as part of conversation history.

Part status lives only in StateView's RAM projection, even if it is completed.
Persisted messages and restored history do not gain this field; consumers know
those entries are finalized. Stream/Turn/attempt/tool execution statuses still
persist through their existing records. Do not use plugin-owned metadata as a
hidden place to store framework UI status, or pass a projected draft to provider
serialization/checkpoint commits.

state_changed stays the shared snapshot event for standalone/Session consumers.
SDK users do not need per-token persistence or client-side event assembly.

## API update and implementation scope

No external plugins have been released. Update core, built-in plugins and repo
examples directly, without a compatibility or consumer migration phase.

- Replace ModelChunk's message-delta with the eight typed part variants; keep
  usage/response. Chunk discriminants and event strings share spelling; runtime
  supplies metadata unavailable to the adapter.
- Update Responses/Chat adapters, ScriptedProvider, primary/auxiliary loops,
  StateView, LoggerPlugin and OpenTelemetryPlugin together.
- Export the three maps and streaming snapshot part type. Update public type
  tests, developer examples and documentation using event.type.
- Update the public adapter contract directly and document the explicit lifecycle.
  Packages retain independent versions. Add no delta-only compatibility fallback
  or invented completed parts.
- No schema change: events/UI part statuses are ephemeral; MessageData keeps
  its schema and existing histories remain readable.

## Verification requirements

Cover multiple/interleaved parts, empty/final-only parts, fragmented arguments
and identities, invalid JSON, error, cancellation and retry. Include Responses
with separate native item IDs under one message and Chat without explicit part
end events.

Check standalone/Session and primary/auxiliary parity, immutable snapshots with
no ghost drafts or auxiliary text, exactly one permitted tool execution after
final response, and history/provider continuity after restart. Update logger
and trace assertions without vendor-specific logic in core.

Assert canonical checkpoint messages and provider requests never contain the
UI-only part status or incomplete runtime tool-call shapes. Application data and
metadata, including an application key named status, retain their own contract.
Restoring history must not recreate a live draft or open part from these RAM-only
fields. Persisted execution status remains available for recovery as before.

Run typecheck, build, package tests, integration tests and check:boundaries.
