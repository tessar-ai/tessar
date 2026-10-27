# @tessar/core

Tessar's TypeScript API for Agent, Controller, Session, Thread, messages,
tools, hooks, state and checkpoints. Requires Node 24.22.1 or newer.

```sh
npm install @tessar/core @tessar/openai zod
```

- `Agent` owns its model, instructions, tools, limits and the agent loop.
- `Controller({ id, agent, plugins })` owns plugin setup, resources and sessions.
- An executable model lets Agent run directly, without public init/dispose.
- When opting into Controller, initialize it before its sessions or plugin-backed
  executions and dispose it when finished.
- `agent.stream()` creates an independent task; `agent.generate()` collects the
  same execution. A Session manages a continuing conversation with
  `session.subscribe()` and queued `session.followUp()` inputs.
- Core manages state and checkpoints, using memory storage by default.

Tools can return `context.suspend(payload)` to wait for external input. Optional
`resumeSchema` validates the response; `resume(response, input, context)` can
continue the tool without replaying `execute()`. Without that callback, the
response becomes the tool result. Standalone callers continue through
`agent.resume({ threadId, interruptId, value })`, which returns a new event stream
for the same execution. Session callers use `session.resume()` and their existing
subscription. See the [tool guide](../../examples/guide/tools.md) for user questions,
conditional approval, UI integration and persistence boundaries.

```ts
import { Agent, Controller, HumanMessage, ToolMessage } from "@tessar/core";
import { createTool } from "@tessar/core/tool";
import { OpenAIProvider } from "@tessar/openai";
import { z } from "zod";

const addTool = createTool({
  name: "add",
  description: "Add two numbers",
  schema: z.object({ a: z.number(), b: z.number() }),
  execute: ({ a, b }) => ({ sum: a + b }),
});

const agent = new Agent({
  id: "assistant",
  model: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL!,
  }),
  tools: { addTool },
});

const result = await agent.generate("What is 1 + 2?");
console.log(result.output);
```

Tools can also be registered by plugins using `tessar.tools.register(addTool)`.
Both paths share hooks and execution. Tool names must be unique.
`tools: { concurrency: 4, addTool }` optionally limits active calls, including
plugin tools; omit concurrency to execute the model's tool calls without a
scheduling limit. Tools are authorized before dispatch; results enter the
conversation in call order after the executions complete. Execution budgets
such as `limits.maxToolCalls` still apply.

The Agent constructor's `model` option is required; read it with `agent.getModel()`. `stream(message, options?)` and
`generate(message, options?)` accept a string, a message, or message history.
Each direct call has independent context and automatic per-execution cleanup.
Use a Session when the host needs a continuing conversation.

```ts
const stream = agent.stream("Explain briefly", {
  model: "another-model-on-the-same-connection",
  modelOptions: { reasoning: { effort: "low" } },
});
for await (const event of stream) console.log(event);
```

A string model override keeps the default connection. An executable model
instance selects its own connection and request defaults. `modelOptions`
replaces top-level values, including whole nested objects, for that call only.
Omitted provider settings are left to the provider SDK. Legacy object-input
overloads/model references remain for existing Controller integrations.

Zod validates arguments and infers executor input; Tessar generates the model's
JSON Schema. Return text or JSON directly: Tessar wraps it in a `ToolMessage`
and binds the toolCallId. Undefined and non-JSON returns fail explicitly.
To supply content parts or metadata, return a message yourself:

```ts
new ToolMessage("Already calculated", { metadata: { source: "cache" } });
```

All messages have an ID, role, content and optional metadata. Constructors infer
the role and generate an ID unless supplied. Metadata is persisted for hosts and
plugins and is not automatically sent to a model. Standalone ToolMessages may
omit toolCallId; encoding history requires it, and the tool runtime binds it
automatically. OpenAI Responses serializes JSON tool data as JSON text.

Retry, conditional availability and permissions belong in tool implementations
or plugins. Use `context.prepare` to select advertised tools and `tool.before` to enforce
execution policy. Skills and subagents are host/plugin orchestration, expressed
to providers through instructions, messages and tools.

Build instructions from sections when plugins need to append their own content:

```ts
import { buildInstruction } from "@tessar/core";

const instructions = buildInstruction([
  { id: "base", content: "You are an assistant.", order: 0 },
  { id: "skills", content: "<skills>...</skills>", order: 100 },
  { id: "current-context", content: "Current task details", order: 1000 },
]);
const agent = new Agent({ id: "assistant", model, instructions });
```

Sections sort by ascending `order`, with omitted order comparing as zero. Equal
orders sort by ordinal ID, independent of plugin registration order. Use distinct
orders when sequence matters. IDs must be unique and orders finite numbers.
Building copies/freezes the data; it does not mutate caller arrays or inject a
default order. String instructions remain supported. Final requests are normalized
after `context.prepare`, including sections added by plugins. `provider.request`
transforms the native body after adapter encoding; it does not rewrite stored history.
Ordering controls content placement; provider adapters own serialization and cache
behavior. Core adds no cache markers or history breakpoint API.

Built-in and custom plugins use classes instantiated with `new`, implementing
the same `Plugin` instance contract. Provider adapters are separate packages,
such as `@tessar/openai`; persistence backends such as `@tessar/sqlite` attach
through Controller plugins.

All hooks share `tessar.hook` and one typed EventMap. Import event groups directly:

```ts
import { model, thread, session } from "@tessar/core";

tessar.hook(model.usage, event => console.log(event.payload.usage));
tessar.hook(thread.beforeDelete, () => ({ decision: "deny", reason: "Keep history" }));
tessar.hook(session.model.beforeChange, event => console.log(event.payload.model));
```

Keys start lowercase and use camelCase for hyphens in the string identifier:
`thread.beforeDelete === "thread.before-delete"`. There is no `events` prefix.
The old `AgentEvents` and `SessionEvents` exports are replaced by these groups.
Session selection policies are asynchronous: use `await session.model.switch(modelId, options)`
before queuing input that should use the new model. See
[plugin authoring](../../docs/plugin-authoring.md) for decisions and capabilities.

This is an early 0.x release. See the
[repository](https://github.com/tessar-ai/tessar) for complete TypeScript
examples and the current API contracts. The bundled model catalog includes its
upstream license at `src/models/catalog.LICENSE`.

## Persistent Sessions

`await controller.createSession({ scope, metadata })` commits a Session record
before returning the handle. `session.id` is generated by Tessar. Use
`await controller.getSession(id, { scope })` to restore it and
`await controller.listSessions({ scope, limit, cursor })` to browse this Agent's
Sessions. A restored handle does not automatically resume unfinished work.

Selections use compare-and-set: stale handles fail `CommitConflict`; reload the
Session before retrying. Thread creation may succeed before selection fails,
so the unselected thread remains available in the scoped thread list. Closing
a Session keeps its record. Soft-deleting a thread clears stored selections in
the same transaction. Subscribers and unadmitted followUp queues stay in memory.

There is no Agent table. The application constructs its Agent and supplies the
same `agentId` and compatible providers/plugins on restart. Controller's ID is
not a persistence key. Session creation notifications are available to Controller
plugins; subscribe on the returned handle for subsequent events. Restoration
does not emit another `session.created` notification.

`session.thread.delete()` is a soft delete. `session.thread.purge({ threadId })` permanently
removes only a deleted, inactive, unowned thread with no retained fork referencing
it. Both invoke thread deletion policy; purge supplies `permanent: true`.

Controller owns lifecycle, plugins and Session creation/restoration/listing.
Model selection and thread CRUD belong to Session. Use `session.model.get()`
for the full provider/model ID, `name()` for its native ID, and `list()` for
readonly `{ id, name, profile }` entries. `switch(id, options?)` replaces previous
Session overrides with destination defaults plus the supplied shallow options.
Already accepted input keeps its model/options snapshot.

Storage adapter authors must implement the new `sessions` CAS port, backend page
and history queries, `threads.get(..., { includeDeleted })` and `threads.purge`.
These are breaking storage-port changes; run storage conformance and query tests.

`session.model.info()` returns the current immutable `{ id, name, profile, options? }` snapshot. `session.model.setEffort(level)` maps the level through the selected provider while preserving other options. Providers may omit effort support. Model selection changes emit `session.modelChanged`; native option changes emit `session.model.optionsChanged` after persistence.
