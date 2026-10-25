# @tessar/opentelemetry

Optional tracing for Tessar through the official OpenTelemetry SDK and OTLP/HTTP
JSON exporter. Requires Node.js >=24.22.1. One plugin records executions; adapters
configure destinations and platform fields without duplicating hooks.

```sh
npm install @tessar/core @tessar/opentelemetry
```

```ts
import { OpenTelemetryPlugin, LangfuseAdapter } from "@tessar/opentelemetry";

const tracing = new OpenTelemetryPlugin({
  serviceName: "my-app",
  tags: ["production"],
  adapters: [new LangfuseAdapter({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  })],
});
// new Controller({ id, agent, plugins: [tracing] })
// await controller.initialize();
// Use agent.stream()/generate() or a Session.
// await controller.dispose(); // Flush buffered exports before exit.
```

## Plugin options

| Option | Meaning |
| --- | --- |
| `adapters` | Required nonempty array of `TraceAdapter` instances. Each destination receives the same trace/span IDs. |
| `realtime` | Optional boolean, defaults to `false`. Set `true` to export each completed span immediately to every adapter; otherwise use background batching. |
| `serviceName` | Optional OpenTelemetry `service.name` resource attribute. |
| `traceName` | Optional shared trace name; otherwise Agent ID, plus Thread ID for Session calls. |
| `tags` | Optional application-defined tags propagated to each observation. |

`realtime: true` uses the native OpenTelemetry `SimpleSpanProcessor`; it does not
stream individual tokens or publish unfinished spans. Network delivery and the
destination UI can still add latency. Await Controller disposal in either mode
to finish pending exports. Omitted `realtime` and explicit `false` both retain
the default `BatchSpanProcessor` and its SDK batching configuration.

## Adapters

All classes are named exports from `@tessar/opentelemetry`. Configuration options
are optional unless a requirement is stated below. Explicit values override
environment variables. `endpoint` always means a complete HTTP(S) trace URL,
including `/v1/traces`; `baseUrl` means a platform base URL.

| Class | Configuration | Default destination |
| --- | --- | --- |
| `OTLPAdapter` | `endpoint?`, `headers?` | Native SDK `OTEL_EXPORTER_OTLP_*` environment configuration, otherwise localhost:4318. |
| `LangfuseAdapter` | `publicKey?`, `secretKey?`, `baseUrl?`, `prompt?: { name, version }` | Langfuse EU Cloud; supports another region or self-hosting. Both keys are required via options or `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`. `LANGFUSE_BASE_URL` selects deployment. |
| `ArizeAdapter` | `apiKey?`, `spaceId?`, `projectName?`, `endpoint?` | Arize AX. Key, space and project are required via options or `ARIZE_API_KEY`, `ARIZE_SPACE_ID`, `ARIZE_PROJECT_NAME`. Endpoint can use `ARIZE_COLLECTOR_ENDPOINT`. |
| `TraceloopAdapter` | `apiKey?`, `endpoint?` | Traceloop Cloud. Key is required via options or `TRACELOOP_API_KEY`. `TRACELOOP_BASE_URL` selects an alternative base URL. |

Langfuse maps ingestion-v4 observation attributes and exclusive token buckets.
Its optional prompt reference links primary generations to an existing Langfuse
prompt; it does not upload instructions. Arize maps OpenInference attributes and
project resources.
Traceloop receives OpenLLMetry compatibility fields. No platform SDK is required.

Use `OTLPAdapter` for an OTel Collector or another compatible OTLP receiver.
Copy the full trace endpoint and authentication header from your deployment:

```ts
new OTLPAdapter({
  endpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT!,
  headers: { Authorization: process.env.OTEL_AUTHORIZATION! },
});
```

You can provide several adapters to export to several destinations. Adapter
mappings use independent snapshots and cannot add platform fields to other
adapters' spans. Implement `TraceAdapter.createExporter()` to supply another
OpenTelemetry `SpanExporter`, or extend `OTLPAdapter` and override its protected
`mapSpan()` for a receiver-specific mapping.

## Trace contents and conventions

Each Agent invocation or Session follow-up creates its own trace with an Agent
root. Langfuse groups these traces into a Session identified by the Tessar Thread
ID; the original Tessar Session ID remains in observation metadata. Direct Agent
calls do not create a Langfuse Session. The hierarchy is Agent -> numbered Turns
-> model attempts and tools. Auxiliary model calls keep their own input/output and originating tool
parent. Effective requests include instructions, history, tools and configured
options. Turn output records committed assistant/tool messages.
Stream, Turn, model and tool spans use recorded lifecycle start/end times rather
than notification delivery time. Turn spans include context preparation. Ordered
tool result publication can happen later than execution completion, especially
with parallel tools. Auxiliary calls made after a Turn ends attach to the Agent
root instead of creating an extra Turn. Consumer delivery errors do not fail it.

Shared spans use GenAI attributes for operation, provider, requested model,
Agent/conversation IDs and known input/output, cache and reasoning token counts.
GenAI system instructions and input/output message parts preserve text, reasoning
and tool calls/results separately. Media/custom parts retain their original types
as generic parts. This remains a subset of GenAI conventions, not complete
conformance. Original requests, responses and usage stay lossless in `tessar.*`.
Adapter display mappings include ordered instructions as a System message.
Langfuse omits the duplicate instructions field from Additional Input; Arize
LLM messages use typed text/reasoning contents and conventional `message.tool_calls`.
Arize Turns remain CHAIN spans. Both Turn and model I/O panels receive readable
transcripts including System instructions and the model request's full history.
Arize uses OpenInference conversation fields without duplicate GenAI message or
instruction attributes, which its ingestion would normalize a second time. The receiving UI
decides how to render typed reasoning; Tessar does not flatten it into answer text.
Available tool definitions are exported as `gen_ai.tool.definitions`; Arize also
receives `llm.tools.*`, structured tool calls and tool-result correlation IDs. A tool
span records its own description and parameter schema: Arize maps these to
`tool.description` / `tool.parameters`, while Langfuse and Traceloop expose
`toolDescription` / `toolParameters` in observation metadata / association properties.
Arguments remain the tool input; the parameter schema describes allowed inputs.
Traceloop tool results use JSON text in its message display mapping so objects
are readable; the original structured result remains in `tessar.*`. Dashboard
tabs and layouts are controlled by the receiving platform.

The request's `tools` list shows tools available to the model, not tools executed
in that Turn. Only executed tools get child tool spans under their calling Turn.
Unknown token counts are omitted. Costs and scores
are calculated or submitted through the destination's own features; Tessar does
not infer a routed model's price or generate evaluation scores.

Turn counters are checkpointed under plugin ID `opentelemetry`, namespace `trace`,
with reset on fork. Persistent storage retains Turn numbering and Langfuse Thread
grouping after restart; each invocation still owns a new root with its own input,
output, status and timing. Resume/recovery creates another trace segment with the
same logical `streamId`. A continued Turn retains its logical ID and number but
gets a fresh observation under that segment's root. Trace IDs include the Stream
and resumed checkpoint identity; ended parents are never reused or exported again.
Resumed observations never start before their new segment root; cached results
predating that segment are published without negative durations. Original record
times remain in `tessar.metadata.recordStartedAt` / `recordEndedAt`.
Older `opentelemetry` counter snapshots remain readable; obsolete parent flags
are ignored. Effective conversation history is recorded on each model attempt.

Each plugin owns its tracer and explicit span parents without replacing the
application's global OTel provider. The SDK exports completed spans asynchronously,
using background batching by default; export failures do not fail agent execution. Export is best-effort,
not a durable event journal. Await Controller disposal to drain buffered spans.
Requests and application metadata are sent to the chosen destinations.

## Migration

This package replaces `@tessar/langfuse` in this repository. Replace
`new LangfusePlugin(options)` with
`new OpenTelemetryPlugin({ adapters: [new LangfuseAdapter(platformOptions)], ...sharedOptions })`.
Move `publicKey`, `secretKey`, `baseUrl` and `prompt` to the adapter; keep
`traceName` and `tags` on the plugin. Existing `langfuse` checkpoint markers are
not migrated to the new plugin identity; continuing such a Thread does not
preserve its previous Turn counter. Use a new Thread when adopting this package.

See the [developer guide](../../examples/guide/opentelemetry.md) for complete
Agent and Session examples and links to platform documentation.



