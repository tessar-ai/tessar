# Build with Tessar

These guides are for developers building their own CLI or embedding an agent in
an application. Code uses public package imports, rather than test helpers or
private source files.

## Set up an application

Use Node.js **24.22.1 or newer**. In a new application directory:

```sh
npm init -y
npm pkg set type=module
npm install @tessar/core @tessar/openai zod
```

Create `.env` and keep it out of version control:

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=your-model-id
```

Use a model available to your account. Each guide identifies the filename for
its complete example. Node can execute these examples directly:

```sh
node --env-file=.env agent.ts
```

Additional snippets on a page continue that page's example unless stated
otherwise. Choose the provider options supported by your endpoint and model.
Examples perform real model requests and can incur provider charges.

## Choose a starting point

| You want to… | Read |
| --- | --- |
| Run an agent without application lifecycle code | [Agent](agent.md) |
| Display output as it arrives | [Streaming](stream.md) |
| Give the agent application functions | [Tools and messages](tools.md) |
| Keep a conversation and queue new input | [Controller and Session](sessions.md) |
| Add hooks and capabilities through plugins | [Plugins](plugins.md) |
| Trace model calls, tools and execution lifecycle | [OpenTelemetry](opentelemetry.md) |
| Keep history across application restarts | [Storage](storage.md) |
| Classify, route or check policy using TypeSafe | [TypeSafe](typesafe.md) |
| Identify errors safely and define custom failures | [Errors](errors.md) |

`Agent` is enough for direct execution. A `Controller` adds plugin and shared
service lifecycle; a `Session` adds a conversation interface around threads.
Default storage is in memory. Durable storage is an explicit plugin choice.

