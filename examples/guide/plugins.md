# Plugins

[All guides](README.md) · Next: [Storage](storage.md)

A plugin is a class instance implementing `Plugin`. Its `setup(tessar)` method
registers capabilities and hooks. Pass plugin instances to a Controller; their
setup and cleanup follow the Controller's lifecycle.

## Register a tool and extend instructions

Install the optional logger package:

```sh
npm install @tessar/plugins
```

Save as `plugins.ts` after the [setup](README.md).

```ts
import {
  Agent, Controller, buildInstruction, context,
  type Plugin, type PluginContext,
} from "@tessar/core";
import { createTool } from "@tessar/core/tool";
import { OpenAIProvider } from "@tessar/openai";
import { LoggerPlugin } from "@tessar/plugins/logger";
import { z } from "zod";

class AppInfoPlugin implements Plugin {
  readonly id = "app-info";

  setup(tessar: PluginContext): void {
    tessar.tools.register(createTool({
      name: "app_info",
      description: "Read the application's name.",
      schema: z.object({}),
      execute: () => ({ name: "My assistant" }),
    }));

    tessar.hook(context.prepare, event => ({
      ...event.payload,
      instructions: buildInstruction([
        ...event.payload.instructions.sections,
        {
          id: "app-info:instructions",
          order: 1000,
          content: "Use app_info when asked about this application.",
        },
      ]),
    }));
  }
}

const agent = new Agent({
  id: "assistant",
  model: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL!,
  }),
  instructions: "You are a concise assistant.",
});
const controller = new Controller({
  id: "my-app",
  agent,
  plugins: [new AppInfoPlugin(), new LoggerPlugin()],
});

try {
  await controller.initialize();
  console.log((await agent.generate("What application is this?")).output);
} finally {
  await controller.dispose();
}
```

`context.prepare` transforms the Agent loop's normalized model context. The example keeps
the existing request and instructions, then adds an ordered section. This affects
the prepared request; it does not rewrite stored conversation history. Section
order controls instruction placement independently of plugin discovery order.
The logger writes JSON entries to stderr by default. Configure transports to
write files or connect your application's logging system.

## Change a provider-native request

`provider.request` runs after the adapter encodes the SDK body, before the SDK call.
Use it for provider-specific fields rather than adding those fields to Tessar
messages or instructions. For example, add this plugin to your Controller:

```ts
import { provider, type Plugin, type PluginContext } from "@tessar/core";

class RequestOptionsPlugin implements Plugin {
  readonly id = "request-options";

  setup(tessar: PluginContext): void {
    tessar.hook(provider.request, event => {
      if (event.payload.model.providerId !== "openai") return;
      return {
        ...event.payload,
        body: { ...event.payload.body, service_tier: "auto" },
      };
    });
  }
}
```

Only send fields supported by the selected provider. Payload fields are `model`,
`protocol`, `attemptId`, `purpose` (`primary` or `auxiliary`) and `body`.
Return the full envelope with a replacement body; returning nothing keeps it.
Handlers are awaited in registration order, each seeing the preceding result.
Payloads are immutable. Do not change execution identity, the native model,
streaming mode, endpoint, credentials, or SDK client options through this hook.
Invalid replacements and thrown errors fail the attempt without sending a fallback.

The hook runs once per adapter invocation; SDK HTTP retries reuse that body.
It covers primary and auxiliary model calls. `context.prepare` stays on the
Agent loop; auxiliary calls use the request explicitly supplied by the plugin.
`model.start.request` is normalized context, while `provider.request.body` is the
native SDK body at that handler's position. Later handlers and SDK serialization
may still affect what is sent; neither snapshot represents HTTP headers.

An Agent created by a user plugin has its own context preparation. If it needs
hooks, the plugin creates a Controller for that Agent with the selected plugin
instances. `tessar.agent.register(agent)` registers the Agent and its shutdown;
it does not inherit the parent's Controller, hooks, history or tools. A separate
process creates its own runtime. These choices remain plugin responsibilities.

Provider adapter authors invoke the optional
`ModelCallContext.prepareRequest(protocol, body)` after encoding and await its
result before SDK invocation. Agent calls without a Controller still work.

## Configure logging

```ts
import {
  LoggerPlugin, FileTransport, logGroup,
} from "@tessar/plugins/logger";

const logger = new LoggerPlugin({
  level: "info",
  transports: [new FileTransport({
    path: "./logs/my-app.jsonl",
    groupBy: logGroup.session,
  })],
});
// Use logger in new Controller({ id, agent, plugins: [logger] }).
```

`level` is the minimum severity (`debug < info < warn < error`), defaulting to
`info`. Use `debug` to include input messages, text/reasoning deltas, tool progress
and model usage. Lifecycle events are info, suspension is warn and events with
errors are error. Filtering happens before any transport writes.

`FileTransport.path` names the fallback file. Omitting `groupBy` writes all
entries to that file. Grouping uses its parent directory and extension:

| Group | Destination for `path: "./logs/my-app.jsonl"` |
| --- | --- |
| `logGroup.none` | `logs/my-app.jsonl` |
| `logGroup.thread` | `logs/threads/<threadId>.jsonl` |
| `logGroup.session` | `logs/sessions/<sessionId>/<threadId>.jsonl` |
| `logGroup.stream` | `logs/streams/<streamId>.jsonl` |

Entries missing the required IDs go into `my-app.jsonl`; no extra Session-level
file is created. Choosing `.log` in `path` changes the extension for all these
files; their contents remain JSON Lines. Caller-supplied IDs are encoded for
portable filenames; IDs in the entries are unchanged. File creation is lazy.
Await `controller.dispose()` at shutdown so pending log entries are written.

To also print logs, add `new ConsoleTransport()` to the transports array. Omitting
`transports` uses ConsoleTransport writing to stderr; an empty array disables
output. Each LoggerPlugin owns its transport instances and closes them on cleanup.

## Custom log transports

Use the public `LogTransport` contract to integrate another logging service.
The following class belongs to the consuming application; Tessar does not
provide a built-in HTTP transport:

```ts
import { LoggerPlugin, type LogEntry, type LogTransport } from "@tessar/plugins/logger";

class HttpTransport implements LogTransport {
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async write(entry: LogEntry): Promise<void> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Log endpoint returned HTTP ${response.status}`);
  }
}

const logger = new LoggerPlugin({
  transports: [new HttpTransport("https://logs.example.com/ingest")],
});
```

The application decides credentials and the destination's expected payload. A
transport can optionally implement `close(): void | Promise<void>` to flush its
buffers or release resources. Transport failures are reported as diagnostics;
other destinations still receive the entry. Replace the former
`new LoggerPlugin({ write })` API with `transports: [yourTransport]`.

## Hook and registration APIs

`model.start`, `model.usage`, `model.end` and `model.error` cover primary and
auxiliary model attempts. Their `purpose` distinguishes the two. A hook that
launches an auxiliary model in response to model completion should filter for
primary completion to avoid calling itself recursively. `model.start` also
includes the effective `request`, `turnId` and `parentToolExecutionId`; tool start
includes the effective name, arguments and turn ID. These are shared runtime
events available to every plugin.

| API | Purpose |
| --- | --- |
| `tessar.tools.register(tool)` | Add an application tool |
| `tessar.models.register(provider)` | Add a model provider factory |
| `tessar.storage.register(backend)` | Select the Controller's storage backend |
| `tessar.agent.register(agent)` | Register an Agent owned by this plugin |
| `tessar.state.define(definition)` | Define checkpointed plugin state |
| `tessar.effects.register(definition)` | Define a tracked effect |
| `tessar.interruptions.register(definition)` | Define a resumable interruption |
| `tessar.registry.register(kind, id, value)` | Expose a custom capability |
| `tessar.hook(event, handler)` | Observe, transform or decide at an extension point |
| `tessar.defer(cleanup)` | Release resources when the plugin is disposed |

Import event maps such as `context`, `tool`, `message` and `stream` for
autocomplete. Their values remain ordinary event strings. Handler payloads and
return values depend on the hook; observation alone does not modify execution.
Hook context exposes captured capabilities through `registry.get()` and `list()`.

A provider instance on Agent already supplies its provider binding to Controller.
Do not register the same provider ID again through a plugin. Different provider
IDs can be added when your application needs a model catalog.

## Load plugins after packaging your CLI

Use this separate host example instead of the preceding one. Save as
`load-plugins.ts`; your CLI can choose any directory name.

```ts
import { Agent, Controller } from "@tessar/core";
import { OpenAIProvider } from "@tessar/openai";
import { PluginManager } from "@tessar/plugins";

const manager = new PluginManager({
  directory: ".my-cli",
  hostUrl: import.meta.url,
});
const agent = new Agent({
  id: "assistant",
  model: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL!,
  }),
});
let controller: Controller | undefined;
try {
  const userPlugins = await manager.load();
  controller = new Controller({ id: "my-cli", agent, plugins: userPlugins });
  await controller.initialize();
  console.log((await agent.generate("Hello")).output);
} finally {
  try { await controller?.dispose(); }
  finally { manager.dispose(); }
}
```

Users can place custom files in `.my-cli/plugins/`. For example, save this as
`.my-cli/plugins/local-info.ts`:

```ts
import { ready, type Plugin, type PluginContext } from "@tessar/core";

// For a custom file with no extra package dependencies, implement Plugin directly.
class LocalInfoPlugin implements Plugin {
  readonly id = "local-info";
  setup(tessar: PluginContext): void {
    tessar.hook(ready, () => { console.error("Local plugin loaded"); });
  }
}
export default new LocalInfoPlugin();
```

The loader supplies the host's `@tessar/core`; custom files do not need their own
core installation. Erasable TypeScript is supported. Other dependencies still
need to be available in the plugin's environment.

```text
.my-cli/
├── plugins/                 # Custom files, or directories with index entries
│   └── local-info.ts
├── plugins.json             # Installed plugin entry names
└── npm/                     # Managed npm package environment
    ├── package.json
    ├── package-lock.json
    └── node_modules/
```

For distributed plugin packages, expose `manager.install(source)`,
`manager.update(name)` and `manager.remove(name)` through your own CLI commands.
Installation records entries in `plugins.json`; `load()` discovers custom files
and loads configured packages, without installing missing dependencies. Tessar
does not impose a CLI command name. See [PluginManager](../../packages/plugins/README.md).

## Change active plugins without a manager

Controller accepts plugin instances. PluginManager only discovers/imports external
modules and manages npm packages; it does not run plugin setup or cleanup.

On an initialized Controller, an application can enable a logger for future
executions and later disable it, using an ordinary imported plugin:

```ts
await controller.plugins.attach(new LoggerPlugin());
// Execute work with logging enabled.
await controller.plugins.detach("logger");
```

These operations need no PluginManager. Existing executions keep their captured
plugin registrations until they release them; cleanup can therefore occur after
`detach()` resolves. Storage must be configured before initialization.

Applications with a fixed plugin list only need the constructor's `plugins` array
and `controller.dispose()` at shutdown. External plugins can use the same runtime
operations after a separate `manager.load()` call. Loading does not watch files,
activate plugins or filter IDs already attached to the Controller.
