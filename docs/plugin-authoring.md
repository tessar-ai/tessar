# Writing a Tessar plugin

For the complete current event catalog, payloads, return types and plugin
capabilities, see [Event hooks and Plugin API](plugin-api-and-events.md).

Use public exports from `@tessar/core`. Built-in and custom plugins are classes
instantiated with `new`. Implement `Plugin` to describe the instance's ID and setup
method; no base class or apiVersion is required. Setup receives `tessar: PluginContext`.

```ts
import { model, tool, thread, diagnostic, type Plugin, type PluginContext } from "@tessar/core";
import { createTool } from "@tessar/core/tool";
import { z } from "zod";

export class GreetingPlugin implements Plugin {
  readonly id = "greeting";
  setup(tessar: PluginContext): void {
    tessar.tools.register(createTool({
      name: "greet",
      description: "Greet one person",
      schema: z.object({ name: z.string() }),
      execute: ({ name }) => `Hello, ${name}`,
    }));
    tessar.hook(model.usage, event => {
      console.log(event.payload.usage);
    });
  }
}

export default new GreetingPlugin();
```

The Zod schema validates untrusted arguments and infers the executor's input.
Tessar uses Zod 4's native input JSON Schema conversion for model descriptions.
Return text or JSON, or `new ToolMessage(content, options)` for content parts and
metadata. ToolMessage is always the normalized execution result; runtime binds
the provider's toolCallId. Metadata stays in local state unless a plugin explicitly
includes it in model context. Missing returns and non-JSON data are rejected.

The same Tool can be declared directly in `new Agent({ id, tools: { greet: greetTool } })`;
no plugin wrapper is required. All tools share hooks, registry snapshots and name
conflict checks. Agent object keys are registered tool aliases; plugin registration
uses the Tool's own name. Agent `tools.concurrency` optionally limits active executions;
omitting it adds no concurrency limit. Policy preparation and approvals happen
before dispatch; executions can complete out of order, and results are published
in call order before the next model call. Completed results are checkpointed
individually and reused during recovery. Unknown dispatched outcomes require the
tool's recovery contract; arbitrary external effects are never blindly replayed.

Use `tools.select` to filter advertised tools and `tool.before` to deny execution.
Retry, per-tool limits, caching, sandboxing and conditional availability belong
in tools or plugins rather than additional core configuration fields.

## Hooks and lifecycle

`tessar.hook(tool.before, handler)` registers a typed hook. Import lowercase
groups directly, without an `events` prefix. Hyphenated string segments have
camelCase map keys: `thread.beforeDelete` is `"thread.before-delete"`, and
`session.model.beforeChange` is `"session.model.before-change"`.
Transform hooks return replacements;
decision hooks return explicit allow/deny/continue/stop decisions. A later handler
cannot overturn a denial. Required handler failures stop execution; notification
errors go to Controller diagnostics. Notifications do not expose mutable execution
services. Session.subscribe is observation and is not awaited as a policy hook.

`diagnostic` exposes Controller diagnostics through the same hook API.
Error records carry an explicit source (`tessar`, `provider`, `plugin`, `tool`,
`storage`, `application`) and available component identity. Provider/plugin
exceptions retain their original objects in-process; JSON snapshots belong to
trace/state. A diagnostic handler failure is isolated without emitting another
diagnostic. `@tessar/plugins/logger` subscribes to lifecycle notifications and diagnostics;
its default ConsoleTransport emits JSON to stderr. Configure `transports` with
FileTransport or a custom LogTransport implementing `write(entry)` and optional `close()`.

Custom events extend EventMap with HookSpec payload/result/context types. Their
default runtime behavior is notification; use the optional registration options
`{kind: "transformation" | "decision" | "barrier"}` for a custom non-notification
contract. A host rejects conflicting kinds/versions for an existing event name.

Session model changes and thread switches, and Thread forks,
renames and deletions have awaited policy hooks. These five operation decisions
accept only `{ decision: "allow" | "deny", reason?: string }` or `undefined`.
Undefined allows; a denial rejects with `OperationDenied`. Invalid decisions
reject with `InvalidHookResult`. They do not suspend an execution.

```ts
tessar.hook(thread.beforeDelete, async (event, context) => {
  const history = await context.thread.getHistory();
  if (history.items.length > 0)
    return { decision: "deny", reason: "Keep conversations with history" };
});
```

`thread.forked`, `thread.renamed` and `thread.deleted` run after successful
persistence through Thread operations and Session wrappers. Session notifications
such as `session.threadRenamed` additionally describe that Session's operation.
Denial or storage failure does not emit success. Scope and storage busy checks
still apply when a policy allows an operation.

Session hooks receive `context.session`; execution hooks receive it when started
through a Session. Thread execution/operation hooks receive `context.thread` when
called through that handle. The Session capability exposes selection, thread
operations and queued follow-up input; the Thread capability exposes identity and
read APIs. Handles are not serialized into events or checkpoints. They are typed
capabilities for trusted plugins, not a sandbox.

`await session.model.switch(modelId, options)` waits for policy before changing the selection.
Concurrent or reentrant Session control mutations reject with `SessionBusy`.
Queued input retains the model/thread snapshot taken when it was accepted.

Setup may return a disposer or register cleanup with tessar.defer. Setup failure
rolls back its registrations. Captured executions keep detached plugin resources
alive until release; new executions see the updated registry. Storage is fixed
after initialization. Importing the core starts no runtime and performs no requests.

## State, interruption and external work

Instruction sections have optional numeric `order`. Add sections through a
request transformation without depending on which plugin registered first:

```ts
import { buildInstruction, context, type Plugin, type PluginContext } from "@tessar/core";

export class SkillsPlugin implements Plugin {
  readonly id = "skills";
  setup(tessar: PluginContext): void {
    tessar.hook(context.prepare, event => ({
      ...event.payload,
      instructions: buildInstruction([
        ...event.payload.instructions.sections,
        { id: "skills.available", content: "<skills-available>...</skills-available>", order: 100 },
      ]),
    }));
  }
}
```

Sections sort by ascending order (omitted means zero), then ordinal ID for ties.
IDs must be unique within the final instruction. Put stable content at lower
orders and content that changes often at higher orders. The final request is
normalized after `context.prepare` and `model.request`, even when a hook returns
a plain instruction object. This controls instruction position independently of
hook invocation order; transform hooks themselves still execute in registration
order. Section IDs/orders do not become provider message metadata. Serialization
and cache behavior remain provider concerns; there is no explicit breakpoint API.

Use tessar.state.define for plugin namespaces, then state access at supported
transform/decision boundaries. Thread/stream/turn state participates in Thread
checkpoints. Explicit agent/session-owned CAS transactions have separate lifetimes;
they are not atomic with a Thread checkpoint or rewound by a Thread fork.

Register typed interruption contracts with tessar.interruptions.register.
Decision context.suspend persists a request and cursor; response resolution must
be deterministic. The host handles the UI and calls Session.resume later. Schema
and interruption versions protect actual persisted data, independently of plugin
setup. Optional plugin version/configuration identifiers guard continuation when
the host needs to detect changed code or configuration after restart.

Tool context models.stream tracks auxiliary usage. effects.execute checkpoints
intent/outcome for a registered effect; unknown outcomes need reconcile evidence.
Plugins can register independent Agents with tessar.agent.register and call their
public stream/generate APIs. Plugins own dispatch, process boundaries, relationships
and aggregation of results or usage; core does not prescribe a child-execution protocol.

Raw I/O in an arbitrary callback is not automatically durable or exactly-once.
Plugins own skill sources, long-term memory storage, command syntax, compression
policy and subagent concurrency/process/result/error handling. Core supplies the
generic state, hooks, checkpoints, progress, cancellation and trace mechanisms.

## Distribution

During development, instantiate the plugin class with `new` and pass the instance
in Controller options. For external loading, default-export an instance, for example
`export default new GreetingPlugin()`. The loader passes that instance to core;
it does not instantiate classes or require a different plugin API.
Node hosts can also use `PluginManager` from the optional `@tessar/plugins`.
The host chooses its directory, calls load before constructing Controller and keeps
the manager alive through Controller disposal. Use a finally block even if loading
or initialization fails. The loader does not call setup or install missing packages.

```ts
const manager = new PluginManager({ directory: resolve(".tessar"), hostUrl: import.meta.url });
let controller: Controller | undefined;
try {
  const agent = new Agent({ id: "host", model });
  const userPlugins = await manager.load();
  controller = new Controller({ id: "host", agent, plugins: userPlugins });
  await controller.initialize();
  // Use the ordinary Agent/Session APIs.
} finally {
  try { await controller?.dispose(); }
  finally { manager.dispose(); }
}
```

Discovery loads sorted files from `<directory>/plugins`, followed by package
names in `<directory>/plugins.json`'s `packages` array. Each module must
default-export a Plugin object. A plugin folder can expose `index.mjs`, `index.js`,
`index.cjs`, `index.mts`, `index.ts` or `index.cts`. Put helper modules inside that
folder; top-level files in plugins are treated as entry points. Declaration files
are ignored. `load(["./custom.mjs", "some-package"])` selects explicit sources
instead; relative paths resolve from the configured directory, while packages
resolve from `<directory>/npm/`.

```json
{
  "packages": ["some-plugin", "@scope/another-plugin"]
}
```

Custom files in `plugins/` do not need entries in this configuration. The npm
manifest and lockfile live at `npm/package.json` and `npm/package-lock.json`,
with installed packages in `npm/node_modules/`. The host chooses the root directory
name; `.tessar` is only the demo's default. Constructors and loading do not
create this layout; `install()` creates the npm environment when needed. Custom
plugin directories are created by the host or user.

Local plugins may import the host's public `@tessar/core` exports, including
event groups, createTool and message classes, without installing another SDK copy.
Scoped Node hooks map SDK imports in the plugin graph to the host, including lazy
imports. Other imports resolve normally relative to the importing file; missing
bare package imports can also resolve from the managed `npm/` environment, with
the original import/require conditions. Dispose
the manager after runtime shutdown to deregister those hooks.

Node 24.22.1+ directly executes local erasable TypeScript. It does not process
tsconfig aliases, TSX, enums or parameter-property transforms. npm packages must
publish JavaScript and declare a compatible `@tessar/core` peer dependency.
Mark that peer optional to avoid npm installing a separate SDK copy; use a
development dependency to build and typecheck the plugin.
The loader supplies the host SDK; it does not adapt incompatible APIs or invent a
separate apiVersion. Existing plugin/interruption versions still guard saved work.

`install(source, {name?})`, `update(name?)` and `remove(name)` delegate to installed
npm in `<directory>/npm/`. The default source can be an npm package/version
or a local package directory. Git/URL/tarball sources should provide their package
name, e.g. `install("git+https://example.com/team/plugin.git#v1", {name: "my-plugin"})`.
The demo CLI accepts `plugins install <source> --name <package>` and `--plugin-dir`.
CLI local paths resolve from the shell's working directory; PluginManager API
local paths resolve from its configured directory. An explicit package name must
match the source's package metadata, even if that name is already a helper dependency.
Only successfully installed plugin names enter `plugins.json`'s `packages` array;
other direct dependencies remain helpers. Existing config/manifest fields and npm
lockfiles are preserved. `remove()` removes the package through npm, then removes
its configuration entry; it does not delete custom files.
Install saves exact versions; update obeys saved dependency constraints. Install an
explicit newer version to move outside them. Await operations and use a single
mutating process per directory. npm may run package lifecycle scripts, and a failed
npm operation is not an atomic rollback of its filesystem changes.

Loading executes trusted code. Module evaluation side effects are not rolled back.
Node caches modules, so restart the host after changing/updating a module on disk.
Runtime attach/detach still works with loaded plugin objects. This is verified for
Node/npm hosts; Bun-compiled binaries and Node SEA require separate packaging tests.

The earlier flat layout (`package.json` with `tessar.plugins` at the manager
root) is replaced. For an existing environment, put the chosen package names in
`plugins.json` and reinstall those packages through the manager into `npm/`.
Existing files are not moved or deleted automatically.

## Durable Session and plugin state

Session creation is asynchronous. Hooks receive `context.session.id` and the
same ID on event envelopes. `session.created` is dispatched after the initial
record commits; handle subscriptions observe subsequent operations. Restoring a
Session does not create a new record or replay creation notifications.

Thread/stream/turn plugin state is part of checkpoints. Small independent state
for an Agent or Session uses `context.state.owned({ type, id })` and explicit CAS;
an Agent owner ID does not imply an Agent table. Scheduler/job data requiring
indexed queries or atomic claims belongs to plugin-owned storage. Plugins cannot
add arbitrary SQL tables through the portable state API.

Permanent deletion uses the existing `thread.beforeDelete` decision hook with
`event.payload.permanent === true`, then `thread.deleted` after success.
