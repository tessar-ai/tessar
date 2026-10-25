# @tessar/openai

OpenAI Responses and Chat Completions provider with model metadata integration.
Requires Node 24.22.1 or newer and uses the official OpenAI SDK.

```sh
npm install @tessar/core @tessar/openai
```

```ts
import { Agent } from "@tessar/core";
import { OpenAIProvider } from "@tessar/openai";

const model = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: process.env.OPENAI_MODEL!,
});
const agent = new Agent({
  id: "assistant",
  model,
});

const result = await agent.generate("Hello");
console.log(result.output);

const stream = agent.stream("Explain briefly", {
  modelOptions: { reasoning: { effort: "low" }, max_output_tokens: 2048 },
});
for await (const event of stream) console.log(event);
```

Agent runs without Controller or public init/dispose. A string `model` override
selects another model ID using the same client; another OpenAIProvider instance
can carry a different endpoint, API key and headers. Request overrides are
execution-local and replace nested objects rather than deep-merging them.

The constructor accepts official SDK client settings (`baseURL`,
`defaultHeaders`, `maxRetries`, `timeout`, etc.) and native options for its API.
`api` defaults to `"responses"`; select `"chat-completions"` for that endpoint:

```ts
const chat = new OpenAIProvider({
  api: "chat-completions",
  apiKey: process.env.PROVIDER_API_KEY!,
  baseURL: process.env.PROVIDER_BASE_URL!,
  model: process.env.PROVIDER_MODEL!,
  reasoning_effort: "high",
  max_completion_tokens: 2048,
});
const chatAgent = new Agent({ id: "chat", model: chat });
await chatAgent.generate("Hello", {
  model: "another-model-on-this-connection",
  modelOptions: { reasoning_effort: "low" },
});
```

Choose fields supported by the target provider/model. Responses uses fields such
as `reasoning` and `max_output_tokens`; Chat Completions uses `reasoning_effort`
and `max_completion_tokens` (or legacy `max_tokens`). Types follow the selected
SDK protocol. `providerId` remains optional and defaults to `"openai"`, including
when using a compatible endpoint. It identifies a Controller registration, not
the HTTP protocol.

`withModel()` and model-ID overrides preserve the selected API and connection.
To change API, endpoint, credentials or headers, pass a different provider instance
as the execution's `model`. `api` never enters the request body and cannot be
changed through `modelOptions`.

Runtime-owned model/input/instructions/tools/stream fields cannot be overridden
through `modelOptions`. Background execution, provider-managed conversations and
`context_management` compaction are not supported by this loop. HTTP/SDK retries are not a mechanism
for silently restarting a stream that has already emitted output.

Unconfigured settings stay absent: Tessar does not inject temperature, reasoning,
output limits, store/include, or SDK retry/timeout defaults. The SDK applies its
own defaults. Configure `maxRetries` and `timeout` in the provider constructor
when needed. `generate()` preserves native provider exceptions on failure.

Ordered instruction sections are joined with `\n\n`: Responses receives one
`instructions` string; Chat Completions receives one leading system message.
Section IDs and orders are local metadata. Chat supports text, user images/files
and function tools, including fragmented parallel calls and native reasoning
continuity. Unsupported audio/deprecated function-call output is rejected. The
Agent consumes one completion choice; `n` may be omitted or set to `1`.

Chat usage is available only when the endpoint reports it. To request streamed
usage, explicitly configure `stream_options: { include_usage: true }`. Tessar
does not add this option; absent usage remains unavailable rather than zero.

Implicit prompt caching remains the provider default. Tessar adds no cache
markers, history breakpoints or cache policy. Stable sections can precede changing
sections using `order`; native cache options pass through only when configured.
Cache hits still depend on the endpoint/model and the actual prompt prefix.

`model.profile()` reads a cached/bundled metadata snapshot without starting network
requests. `await model.refreshProfile()` explicitly refreshes provider metadata;
metadata may be incomplete and carries provenance.

`OpenAIProvider` and `OpenAIPlugin` are the public runtime exports. The low-level
adapters are internal implementations. `OpenAIAPI`, `OpenAIProviderOptions`,
`OpenAIModelOptions`, `OpenAIChatModelOptions`, `OpenAIPluginOptions` and `OpenAIOptions` remain public
types for application configuration. For example, `OpenAIAPI` describes
`"responses" | "chat-completions"`; importing it does not load a runtime value.

`OpenAIPlugin` registers a provider with a Controller. Passing an executable model
to Controller already registers its provider; do not additionally register the
same provider ID with a plugin.

The plugin accepts the same protocol, connection and native request options as
`OpenAIProvider`, except `model`: the registered factory selects that per request.
For example, `new OpenAIPlugin({ api: "chat-completions", providerId: "gateway",
connectionId: "gateway-main", baseURL: "https://gateway.example/v1", temperature: 0.2 })`.
Omitted native request options are not supplied by Tessar.

Each new provider has a separate opaque connection identity; `withModel()` keeps
the existing client and identity. A Controller retains explicitly named executable
connections supplied to Session selection in its current runtime, including when
reopening a Session handle. After restart, recreate/register the original binding
with a stable `connectionId`; stored references do not contain executable clients
or credentials. Changing the endpoint or protocol under that ID is rejected.

This is an early 0.x release. See the
[repository](https://github.com/tessar-ai/tessar) for complete contracts.

## Restoring native conversation state

For durable conversations, assign a stable, nonsecret connection identity:

```ts
const model = new OpenAIProvider({
  connectionId: "primary-openai",
  model: "your-model",
  apiKey: process.env.OPENAI_API_KEY,
});
```

Recreate that binding after restart. Stored continuity includes provider,
connection, protocol and effective endpoint; reusing the ID with a different
endpoint/protocol is rejected. API keys and transport headers are not included
in the descriptor. Unspecified connection IDs remain random and isolated.

Legacy native state has only its old connection ID. An application may explicitly
reuse that saved ID after verifying the original endpoint/protocol itself; Tessar
cannot infer or attest that binding during SQLite migration. Neither the
connection ID nor its descriptor is forwarded as a native request parameter.
