<div align="center">

<img src="docs\assets\logo.png" alt="Tessar" width="160" />

<h1>Tessar</h1>

<h3>Anything can be a plugin.</h3>

<p>
A TypeScript framework and SDK for building CLI agents and embedding agents in applications.
</p>

<p>
  <a href="#install"><b>Install</b></a> ·
  <a href="#your-first-agent"><b>Quick start</b></a> ·
  <a href="examples/guide/README.md"><b>Guides</b></a> ·
  <a href="#packages"><b>Packages</b></a>
</p>

</div>

Start with an Agent, a model and your own tools. Add a Controller when you need plugins, and Sessions when you need conversations. Core provides the agent loop, messages, hooks, state and checkpoints; you choose how to extend them.

## Install

Requires Node.js **24.22.1 or newer**. Examples use TypeScript and ES modules.

```sh
npm install @tessar/core @tessar/openai zod
```

## Your first agent

Create `.env` with your credentials and a model available to your account:

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=your-model-id
```

Save this as `agent.ts` in a project with `"type": "module"` in `package.json`:

```ts
import { Agent } from "@tessar/core";
import { OpenAIProvider } from "@tessar/openai";

const agent = new Agent({
  id: "assistant",
  model: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL!,
  }),
  instructions: "Be concise and helpful.",
});

const result = await agent.generate("What can an agent do with tools?");
for (const message of result.output) {
  for (const part of message.content) {
    if (part.type === "text") console.log(part.text);
  }
}
```

```sh
node --env-file=.env agent.ts
```

Agent runs directly, without Controller initialization. `generate()` returns the
result when execution completes or suspends; it can include multiple model requests
and tool calls. Use `stream()` to consume events as they arrive:

```ts
import { message, stream } from "@tessar/core";

for await (const event of agent.stream("Explain agent tools briefly.")) {
  if (event.type === message.delta && event.payload.partKind === "text") {
    process.stdout.write(event.payload.delta);
  }
  if (event.type === stream.error) throw Error(event.payload.error.message);
}
```

Separate direct calls have independent context. Use a Session for a continuing
conversation, or pass the messages you want each call to receive.

## Add your own tools

```ts
import { createTool } from "@tessar/core/tool";
import { z } from "zod";

const add = createTool({
  name: "add",
  description: "Add two numbers.",
  schema: z.object({ a: z.number(), b: z.number() }),
  execute: ({ a, b }) => ({ sum: a + b }),
});

const calculator = new Agent({
  id: "calculator",
  model: agent.getModel(),
  tools: { add },
});

await calculator.generate("Use add to calculate 27 + 15.");
```

Return text, JSON or a `ToolMessage`. Tessar binds the result to the model's tool
call automatically. Tools can also be registered by plugins.

## Build up as you need

| API          | Use it for                                                             |
| ------------ | ---------------------------------------------------------------------- |
| `Agent`      | Model configuration, instructions, tools, `generate()` and `stream()`  |
| `Controller` | Plugin registration, shared services and storage lifecycle             |
| `Session`    | Queued follow-ups, subscriptions, model selection and thread selection |
| `Thread`     | Conversation history, checkpoints, forks and execution records         |

Plugins can register tools, model providers, storage backends and custom
capabilities, and participate through typed hooks. Skills, long-term memory,
commands, compaction and delegation strategies can be implemented with these
extension APIs to suit your application.

## Guides

Start with the [developer guide](examples/guide/README.md). Examples use the
public SDK and credentials you supply.

| Guide                                                | What it covers                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| [Agent](examples/guide/agent.md)                     | Generate, messages, instructions and model overrides               |
| [Streaming](examples/guide/stream.md)                | Text/reasoning deltas, tools and token usage                       |
| [Tools and messages](examples/guide/tools.md)        | Zod schemas, tool context and `ToolMessage`                        |
| [Controller and Session](examples/guide/sessions.md) | Conversations, queues, subscriptions and threads                   |
| [Plugins](examples/guide/plugins.md)                 | Custom plugins, hooks, logging and loading plugins after packaging |
| [OpenTelemetry](examples/guide/opentelemetry.md)    | Trace model calls, tools, retries and resumed executions           |
| [Storage](examples/guide/storage.md)                 | SQLite, PostgreSQL, MongoDB and restoring conversations            |

## Packages

Install the packages your application uses:

| Package                                               | Provides                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`@tessar/core`](packages/core/README.md)             | Agent execution, sessions, messages, tools, hooks, state and in-memory storage |
| [`@tessar/openai`](packages/openai/README.md)         | OpenAI Responses and Chat Completions adapters, including compatible endpoints |
| [`@tessar/plugins`](packages/plugins/README.md)       | Plugin discovery/loading, npm plugin management and the `/logger` plugin       |
| [`@tessar/opentelemetry`](packages/opentelemetry/README.md)     | OTLP tracing with Langfuse, Arize and Traceloop adapters       |
| [`@tessar/sqlite`](packages/sqlite/README.md)         | SQLite persistence using Node's built-in SQLite API                            |
| [`@tessar/postgresql`](packages/postgresql/README.md) | PostgreSQL persistence                                                         |
| [`@tessar/mongodb`](packages/mongodb/README.md)       | MongoDB persistence                                                            |

Tessar is an early **0.x** SDK; APIs can change between releases. To work on Tessar
itself, see [Contributing](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).
