# Trace executions with OpenTelemetry

[All guides](README.md)

One `OpenTelemetryPlugin` records Tessar executions. Select one or more adapters
for Langfuse, Arize AX, Traceloop or your own OTel Collector.
This package exports traces through OTLP/HTTP JSON and does not install platform
SDKs or automatic instrumentation for unrelated application code.

```sh
npm install @tessar/core @tessar/openai @tessar/opentelemetry
```

## Direct Agent execution

Save as `tracing.ts`. Configure provider and destination credentials in an
ignored `.env` file; set `OPENAI_MODEL` to a model your provider supports.

```ts
import { Agent, Controller, message } from "@tessar/core";
import { OpenAIProvider } from "@tessar/openai";
import { OpenTelemetryPlugin, LangfuseAdapter } from "@tessar/opentelemetry";

const agent = new Agent({
  id: "assistant",
  model: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL!,
  }),
});
const controller = new Controller({
  id: "my-app",
  agent,
  plugins: [new OpenTelemetryPlugin({
    serviceName: "my-app",
    tags: ["support"],
    adapters: [new LangfuseAdapter({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL,
    })],
  })],
});

try {
  await controller.initialize();
  for await (const event of agent.stream("Introduce yourself.")) {
    if (event.type === message.delta && event.payload.partKind === "text") {
      process.stdout.write(event.payload.delta);
    }
  }
} finally {
  await controller.dispose();
}
```

```sh
node --env-file=.env tracing.ts
```

`agent.generate()` uses the same tracing. A Session is optional; initialize the
Controller before invoking an Agent to which it is attached. Await disposal
before exiting so the SDK can flush buffered observations.

To send each completed model/tool/Turn observation as soon as it finishes, add
the optional `realtime: true` to `new OpenTelemetryPlugin({ ... })`. It defaults
to `false`, which keeps background batching. This option applies to all adapters;
it does not publish unfinished observations or stream tokens to the dashboard.
Both modes require awaiting Controller disposal to finish pending exports.

## Select a destination

Import the adapter you need from `@tessar/opentelemetry` and put its instance in
the plugin's `adapters` array. Several adapters receive identical trace/span IDs
with independent platform mappings.

```ts
import {
  OTLPAdapter, LangfuseAdapter, ArizeAdapter, TraceloopAdapter,
} from "@tessar/opentelemetry";

// Langfuse Cloud region or self-hosted base URL; keys use LANGFUSE_* variables.
new LangfuseAdapter({
  baseUrl: "https://cloud.langfuse.com",
  prompt: { name: "support-system", version: 3 }, // Optional existing prompt.
});

new ArizeAdapter({
  apiKey: process.env.ARIZE_API_KEY,
  spaceId: process.env.ARIZE_SPACE_ID,
  projectName: "my-app",
});

new TraceloopAdapter({ apiKey: process.env.TRACELOOP_API_KEY });

// Collector: supply its trace endpoint and authentication header if required.
new OTLPAdapter({
  endpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT!,
  headers: { Authorization: process.env.OTEL_AUTHORIZATION! },
});
```

Only instantiate the selected destinations. Langfuse requires both keys; Arize
requires key, space and project; Traceloop requires a key. Explicit
`endpoint` values include `/v1/traces`. The generic adapter can instead rely on
the native SDK's `OTEL_EXPORTER_OTLP_*` environment settings.

## Session conversations

Within the initialized Controller example, replace the direct Stream loop with:

```ts
const session = await controller.createSession({ threadId: "support-chat" });

async function ask(text: string): Promise<void> {
  let unsubscribe = () => {};
  const done = new Promise<void>((resolve, reject) => {
    unsubscribe = session.subscribe(event => {
      if (event.type === "stream.end") {
        if (event.payload.status === "completed") resolve();
        else reject(Error(`Execution ended: ${event.payload.status}`));
      }
      if (event.type === "stream.error") reject(Error(event.payload.error.message));
      if (event.type === "stream.suspended") reject(Error("Resume response required"));
    });
  });
  try {
    await session.followUp(text);
    await done;
  } finally {
    unsubscribe();
  }
}

await ask("My name is Alex.");
await ask("What is my name?");
```

`followUp()` acknowledges input rather than awaiting the final response; this
small helper waits for completion before closing the example. Applications can
keep one subscription and Controller alive across requests.

Each Agent invocation or Session follow-up gets a new trace with an Agent root.
Langfuse groups the traces by Tessar Thread ID using its Sessions feature; the
Tessar Session ID remains in observation metadata. Switching Threads changes that
group; returning continues its Turn sequence. Direct Agent calls have no Langfuse
Session grouping. Model retries create separate generation spans within a Turn.

```text
Langfuse Session: support-chat (Tessar Thread ID)
├── Trace A — first follow-up
│   └── Agent
│       ├── turn 1
│       │   ├── Model attempt
│       │   └── Tool
│       │       └── Auxiliary model attempt, if used
│       └── turn 2
│           └── Model attempt
└── Trace B — second follow-up
    └── Agent
        └── turn 3
            └── Model attempt with effective conversation history
```

The plugin saves Turn counters through existing Thread plugin state
(`opentelemetry` / `trace`). Add a [persistent storage backend](storage.md) to
retain numbering after process restart. Forked Threads start a new sequence and
Langfuse group. Resume/recovery creates a new execution segment and trace, keeping
the same logical Stream ID and Thread grouping. A continued Turn keeps its logical
ID and number but receives a fresh observation under the new Agent root. Every
root owns its segment's input, output, status and timing; closed parents are never
reused. Inspect model attempts for their current request, history, response,
usage and first-output time. Legacy parent flags in this plugin's saved counter
state are ignored without requiring a storage migration.

Lifecycle span times come from Tessar records, not delayed hook delivery. Resume
segments clamp old starts to their new parent; recovered cached results never
produce negative spans. Original record times remain in metadata as
`recordStartedAt` / `recordEndedAt`. Auxiliary model calls after a Turn has ended
attach to the Agent root. Consumer-only Stream errors do not fail the trace.

## Fields and platform behavior

| Data | Shared representation |
| --- | --- |
| Operation, provider, requested model | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model` |
| Agent and conversation | `gen_ai.agent.id`, `gen_ai.conversation.id`; `session.id` is the Tessar Session ID in shared spans and the Thread ID in Langfuse |
| Known token counts | `gen_ai.usage.input_tokens`, `output_tokens`, cache and reasoning details |
| Input/output | JSON under `tessar.input` / `tessar.output`, with receiver-specific mappings |
| Configured options and full usage provenance | JSON under `tessar.*` |
| Names and tags | Shared plugin configuration, translated by adapters |
| Available tools | `gen_ai.tool.definitions`; Arize also maps `llm.tools.*` |
| Executed tool | Name, call ID, description, input schema, arguments and result |

GenAI attributes include `gen_ai.system_instructions`, `gen_ai.input.messages`
and `gen_ai.output.messages`. Text, reasoning, tool calls and tool results remain
separate message parts. Framework instructions are separate from history in
standard GenAI attributes; platform conversation displays prepend them as a
System message, in section order. Media/custom parts retain their original types
as generic parts. This is still a subset of GenAI conventions.

Langfuse Additional Input no longer duplicates instructions already shown in
Messages. Arize LLM spans carry typed OpenInference text/reasoning contents;
Turn spans remain CHAIN and show readable conversation transcripts rather than
serialized Tessar records. Model I/O panels also show readable transcripts with
System instructions and full request history; structured chat messages remain
in `llm.input_messages` / `llm.output_messages`. Arize gets this OpenInference
conversation mapping without duplicate GenAI conversation attributes to prevent
ingestion from merging System instructions again. Traceloop retains structured GenAI parts alongside
legacy text fields that exclude reasoning. The platform UI determines whether
reasoning gets a separate visual block; inspect the typed attributes if needed.
Full original requests and responses remain in `tessar.input` / `tessar.output`.

Arize tool-call messages include function names, arguments and call IDs; tool
results include their call ID and text or serialized JSON data. Tool spans expose
`tool.description` and `tool.parameters` (the input schema). On Langfuse look in
observation metadata for `toolDescription` / `toolParameters`; on Traceloop look
in association properties. The adapters supply these fields, not custom UI tabs.
Traceloop serializes structured tool-result values to JSON text for its message
display while preserving the original result under `tessar.*`.

Every request may advertise both time and weather tools from Turn 1. This list
does not mean both ran in Turn 1. An execution that calls time first and weather
second has the time tool span under Turn 1 and the weather tool span under Turn 2.

Unknown token counts remain absent. Langfuse receives exclusive cache/reasoning
buckets to avoid double counting. Provided model names remain the requested IDs;
Tessar cannot infer the actual priced model behind a router alias. Destinations
calculate costs from their own model pricing. Scores and feedback use the
platform's evaluation API, outside the tracing adapter.

The plugin uses an instance-local tracer with explicit parents and does not
replace the global OTel provider. Each destination has its own SDK processor;
network export is outside execution hooks. Export is best-effort and errors do
not fail the Agent. Checkpoints are not delivery acknowledgements, and an abrupt
process exit can lose buffered spans.

Platform options configure auth and routing, not a platform client for scores or
prompt management. The complete constructor options are listed in the
[package README](../../packages/opentelemetry/README.md). To migrate from
`@tessar/langfuse`, follow its migration section; old plugin checkpoint markers
are not migrated automatically.

References: [GenAI conventions](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/),
[Langfuse OTLP](https://langfuse.com/integrations/native/opentelemetry),
[Arize OTel](https://arize.com/docs/ax/integrations/opentelemetry/opentelemetry-arize-otel),
[Traceloop configuration](https://www.traceloop.com/docs/openllmetry/configuration).


