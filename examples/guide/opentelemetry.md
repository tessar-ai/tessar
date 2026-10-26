# Trace executions with OpenTelemetry

[All guides](README.md)

One `OpenTelemetryPlugin` records Tessar executions. Select one or more adapters
for Langfuse, Laminar or your own OTel Collector.
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
  OTLPAdapter, LangfuseAdapter, LaminarAdapter,
} from "@tessar/opentelemetry";

// Langfuse Cloud region or self-hosted base URL; keys use LANGFUSE_* variables.
new LangfuseAdapter({
  baseUrl: "https://cloud.langfuse.com",
  prompt: { name: "support-system", version: 3 }, // Optional existing prompt.
});

// The project API key identifies the destination project.
new LaminarAdapter(); // Uses LMNR_PROJECT_API_KEY.

// Collector: supply its trace endpoint and authentication header if required.
new OTLPAdapter({
  endpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT!,
  headers: { Authorization: process.env.OTEL_AUTHORIZATION! },
});
```

Only instantiate the selected destinations. Langfuse requires both keys; Laminar
requires its project API key. Explicit
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
Session grouping. Laminar uses the same Thread grouping in its Session association;
the original Tessar Session ID stays in metadata. Model retries create separate
generation spans within a Turn.

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
| Agent and conversation | `gen_ai.agent.id`, `gen_ai.conversation.id`; Langfuse/Laminar conversation groups use the Thread ID |
| Known token counts | `gen_ai.usage.input_tokens`, `output_tokens`, cache and reasoning details |
| Input/output | JSON under `tessar.input` / `tessar.output`, with receiver-specific mappings |
| Configured options and full usage provenance | JSON under `tessar.*` |
| Names and tags | Shared plugin configuration, translated by adapters |
| Available tools | `gen_ai.tool.definitions` |
| Executed tool | Name, call ID, description, input schema, arguments and result |

GenAI attributes include `gen_ai.system_instructions`, `gen_ai.input.messages`
and `gen_ai.output.messages`. Text, reasoning, tool calls and tool results remain
separate message parts. Framework instructions are separate from history in
standard GenAI attributes; platform conversation displays prepend them as a
System message, in section order. Media/custom parts retain their original types
as generic parts. This is still a subset of GenAI conventions.

Langfuse Additional Input does not duplicate instructions already shown in Messages.
Laminar maps Agent roots to EXECUTOR, Turn wrappers to DEFAULT, model attempts to
LLM and tool executions to TOOL. Inspect the Tree view to see all Turn wrappers;
the Transcript view can omit wrapper spans.

Laminar Agent root and Turn I/O are JSON arrays of `{ role, content }`, retaining
typed parts and optional `toolCallId`. Root input includes the first effective
primary request's System message, then the invocation's input. Later model calls
do not replace that instruction snapshot. Turn inputs retain their full effective
conversation history. Record IDs and provider replay state stay out of these
display projections; raw payloads remain in `tessar.input` / `tessar.output`.

Laminar LLM I/O uses `{ role, parts }` GenAI arrays. Its parser expects `thinking`
for reasoning and `result` for a tool response; the adapter translates those
receiver fields without changing Tessar messages. Tool calls keep their order,
arguments and IDs. Tool span I/O is the arguments/result value rather than an
internal message record. Root association metadata and tags describe the trace;
attempt/tool-specific identity stays on its own span instead of propagating globally.

Tool descriptions and schemas remain in GenAI/Tessar attributes. On Langfuse,
`toolDescription` / `toolParameters` also appear in observation metadata.

For example, a Turn input includes JSON such as:

```json
[
  { "role": "system", "content": [{ "type": "text", "text": "You are a helpful assistant." }] },
  { "role": "user", "content": [{ "type": "text", "text": "What is the weather today?" }] }
]
```

This also applies to Laminar root I/O. It changes the
receiver presentation only; provider context, stored messages and the full raw
payload under `tessar.input` / `tessar.output` are unchanged.

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
[Laminar OTLP](https://laminar.sh/article/opentelemetry-for-ai-agents),
[Laminar trace views](https://laminar.sh/docs/platform/viewing-traces).


