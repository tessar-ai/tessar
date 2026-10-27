# Agent: start with a model

[All guides](README.md) · Next: [Tools](tools.md) or [Streaming](stream.md)

`Agent` owns its model, instructions, tools and execution loop. It requires an
application-defined `id` and a default `model`. It can run without a Controller,
Session, `initialize()` or per-call disposal.

## Generate a result

Save as `agent.ts` after completing the [setup](README.md).

```ts
import { Agent, buildInstruction } from "@tessar/core";
import { OpenAIProvider } from "@tessar/openai";

const model = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: process.env.OPENAI_MODEL!,
});

const agent = new Agent({
  id: "assistant",
  model,
  instructions: buildInstruction([
    { id: "base", order: 0, content: "You are a concise assistant." },
    { id: "style", order: 10, content: "Explain unfamiliar terms simply." },
  ]),
});

const result = await agent.generate("Explain what an agent loop does.");
console.log(result.status);
for (const message of result.output) {
  for (const part of message.content) {
    if (part.type === "text") console.log(part.text);
  }
}
console.log(result.usage.metrics);
```

`generate()` consumes the execution and returns its messages, usage and status
when it completes or suspends. An execution can include several model requests
and tool calls. It throws on an execution error. Use [streaming](stream.md) for
live events.

## Set an execution ID

```ts
const events = agent.stream("Hello", { id: "request-42" });
console.log(events.id); // "request-42", available immediately.
for await (const event of events) console.log(event.streamId, event.type);
```

Omit `id` to generate one. The same execution keeps its ID through model/tool
steps and suspension/resume. An Agent resume handle obtains the existing ID after
loading its interruption. Cancel with `events.abort(reason)`; the handle does not
expose an AbortSignal. Existing `streamId` fields on results, events and storage
continue to reference this same ID.

Instruction sections have unique IDs. Lower `order` values come first; IDs break
ties. Put stable sections before changing sections to keep their prompt prefix
stable. Sections are composed into one instruction string by the OpenAI adapter,
rather than becoming one system message each. Caching depends on the endpoint.

## Send input from an external source

Use the existing Stream ID to deliver a signal to a direct execution:

```ts
const events = agent.stream("Review this repository.", { id: "review-42" });

// For example, call this from your application's webhook handler.
async function onBuildFinished() {
  await agent.sendSignal({
    streamId: events.id!,
    content: "The CI checks have passed.",
    tagName: "notification",
    attributes: { source: "github", pr: 123 },
    metadata: { source: "webhook" },
  });
}

for await (const event of events) {
  if (event.type === "text.delta") console.log(event.payload.delta);
}
```

`await sendSignal()` acknowledges reception into memory, like `followUp()`; it
does not wait for checkpoint writes, plugin callbacks or the model's answer.
With `persist: true`, Tessar writes pending input to the configured storage before
applying it to model context. Input received before that write can be lost on a
process crash. Later write/startup failures are reported through execution events
and diagnostics. A standalone Agent uses memory storage; restart durability
requires a persistent backend and a completed checkpoint write.
Signals always create user messages. `tagName` optionally wraps content in XML;
`attributes` requires a tag, uses scalar values and escapes attribute characters.
Names use `[A-Za-z_][A-Za-z0-9_.-]*`. Multipart content stays multipart inside
opening/closing text parts. Message and part metadata follow the normal local
metadata contract and are omitted from provider payloads.

The current model/tool step continues. Input applies before the next model
request, after all results from the current tool batch. Pending input extends
the same execution even if its current model response was a final answer.
Cancellation, explicit stops and configured limits still take priority.

Set `persist: false` to retain input only in that execution's in-memory context,
including subsequent model/tool steps. It survives same-process suspension/resume,
but ends with the execution and is lost on restart. Normal assistant/tool output
is still stored and may refer to that input.

Submit immediately after `stream()` returns, or after admission. Submissions
while an input-admission hook is running fail explicitly rather than waiting on
that hook's own commit; transform its input instead. Closed/unknown Stream IDs
fail. A suspended execution accepts input but still requires explicit `resume()`.
For Session work, target the selected [Thread](sessions.md#send-a-signal-to-the-selected-thread).

## Read the Agent configuration

These synchronous methods work without a Controller or initialization:

```ts
const configuredTools = agent.listTool(); // readonly Tool[]
const defaultModel = agent.getModel(); // Preserves the configured model's type.
const baseInstruction = agent.getInstruction(); // Instruction with ordered sections.
const configuredLimits = agent.limits(); // StreamLimits including loop defaults.
```

They return the Agent's constructor configuration. Per-execution model overrides,
plugin tool registrations and instruction hook transformations do not change
these defaults. Read `baseInstruction.sections` for the structured instruction;
it is not a provider-formatted prompt string.

## Supply conversation messages yourself

Direct calls do not automatically share history. This snippet explicitly passes
an earlier answer into a new execution:

```ts
import { HumanMessage, SystemMessage } from "@tessar/core";

const next = await agent.generate([
  new SystemMessage("Use short examples."),
  new HumanMessage("Explain what an agent loop does."),
  ...result.output,
  new HumanMessage("Now show a concrete example."),
]);
console.log(next.output);
```

For automatic thread history and queued input, use a [Session](sessions.md).

## Attach application metadata to content parts

A single message can contain several ordered parts. Each part accepts optional
`metadata`, independently of the message's own metadata:

```ts
const prompt = new HumanMessage([
  { type: "text", text: "Review this document." },
  {
    type: "text",
    text: "\n\nDocument contents...",
    metadata: { source: "application", custom: { labels: ["reference"] } },
  },
]);
await agent.generate(prompt);
```

Metadata must be a JSON object. Tessar preserves it through message codecs,
events and persisted history/checkpoints. Applications and plugins own the keys
and their meaning; core does not interpret them or filter parts based on them.
The OpenAI adapters encode content without forwarding application metadata.

## Override one execution

Keep the existing endpoint and credentials, but select a different model on that
connection and override its request options:

```ts
const alternateModelId = process.env.OPENAI_ALTERNATE_MODEL;
if (alternateModelId) {
  const alternate = await agent.generate("Explain briefly.", {
    model: alternateModelId,
    modelOptions: { max_output_tokens: 1024 },
  });
  console.log(alternate.output);
}
```

The same options argument works with `agent.stream(input, options)`. Overrides
apply only to that execution. Nested option objects replace the previous object;
they are not deep-merged. Unconfigured options are left to the provider SDK.

To change endpoint, credentials or protocol, pass another model instance:

```ts
if (process.env.COMPATIBLE_API_KEY && process.env.COMPATIBLE_MODEL &&
    process.env.COMPATIBLE_BASE_URL) {
  const compatible = new OpenAIProvider({
    api: "chat-completions",
    apiKey: process.env.COMPATIBLE_API_KEY,
    baseURL: process.env.COMPATIBLE_BASE_URL,
    model: process.env.COMPATIBLE_MODEL,
  });
  console.log((await agent.generate("Hello", { model: compatible })).output);
}
```

Choose the protocol your endpoint supports. Responses and Chat Completions have
different native option names; see [the provider reference](../../packages/openai/README.md).
SDK client settings such as `timeout`, `maxRetries` and `defaultHeaders` belong
in the provider constructor. Calling `model.profile()` returns a metadata snapshot;
`await model.refreshProfile()` explicitly refreshes it. Missing metadata fields
can be `null`.

## Render a standalone stream

`state_changed` is also emitted without a Controller or Session. Each stream has
its own immutable snapshot; simultaneous streams keep separate conversations.

```ts
for await (const event of agent.stream("Hello")) {
  if (event.type === "state_changed") render(event.payload.state);
}
```

`render` is your function. Render `state.messages` directly to show incremental
text/reasoning and completed messages; `state.tools`, `state.interrupt` and
`state.status` describe execution activity. The existing detailed events remain
available for custom integrations. See [Session snapshots](sessions.md#render-snapshots)
for the complete snapshot contract and lifecycle helpers.
