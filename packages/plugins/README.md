# @tessar/plugins

Optional Node host utilities for loading plugins after an application is packaged,
managing npm plugin packages, and structured logging. Requires Node 24.22.1 or newer.

```sh
npm install @tessar/core @tessar/plugins
```

```ts
import { PluginManager } from "@tessar/plugins";
import { LoggerPlugin } from "@tessar/plugins/logger";

const manager = new PluginManager({
  directory: ".my-cli",
  hostUrl: import.meta.url,
});
const userPlugins = await manager.load();
const plugins = [new LoggerPlugin(), ...userPlugins];
// Pass plugins to new Controller({ id, agent, plugins }).
// Dispose Controller first, then call manager.dispose() in finally.
```

Custom files under `plugins/`, or folders with an index entry, default-export a
plugin instance. The manager supplies the host's public `@tessar/core` imports.
Erasable TypeScript custom files are supported; npm packages publish JavaScript.

`install(source)`, `update(name?)` and `remove(name)` use npm in the managed `npm/`
subdirectory. Installed package names are recorded in `plugins.json` under
`packages`; custom files are discovered automatically. `load()` never installs
missing dependencies. A consuming CLI chooses its own command name and directory.

For registry plugins saved with an exact version, an explicit `update(name?)`
installs the registry's `latest` version and saves its exact version again. This
can cross major versions. File, Git, URL and other dependency specifications keep
their selected source and follow native `npm update` behavior. Omit the name to
update configured plugins; unrelated helper dependencies are not selected as targets.

Controller owns plugin setup and cleanup. Its `plugins.attach(instance)` and
`plugins.detach(id)` operations also work with directly imported plugins, without
a PluginManager. The manager does not activate plugins or watch for file changes.

## Logger transports

Logger writes JSON lifecycle/error entries to stderr by default. Configure its
minimum level and destinations through `transports`:

```ts
import {
  LoggerPlugin, ConsoleTransport, FileTransport, logGroup,
} from "@tessar/plugins/logger";

const logger = new LoggerPlugin({
  level: "debug",
  transports: [
    new ConsoleTransport(),
    new FileTransport({ path: "./logs/app.jsonl", groupBy: logGroup.session }),
  ],
});
// Pass logger in Controller's plugins array and await controller.initialize().
// Await controller.dispose() before exiting to drain logs and close transports.
```

`level` defaults to `info`. Thresholds are `debug < info < warn < error`.
Debug includes input messages, text/reasoning deltas, tool progress and model
usage; info includes lifecycle events and model responses. Suspension is warn;
events carrying an error are error. Filtering happens before transport delivery.
Omitting `transports` uses ConsoleTransport; `transports: []` disables output.

`FileTransport` requires a full file `path`. It creates parent directories and
appends one JSON object per line. Both `.log` and `.jsonl` contain JSON Lines;
the extension supplied in `path` is reused for grouped files:

| `groupBy` | File, for `path: "./logs/app.log"` |
| --- | --- |
| Omitted or `logGroup.none` | `logs/app.log` |
| `logGroup.thread` | `logs/threads/<threadId>.log` |
| `logGroup.session` | `logs/sessions/<sessionId>/<threadId>.log` |
| `logGroup.stream` | `logs/streams/<streamId>.log` |

An entry missing the required IDs goes to the original `path`, including a
Session event without a Thread. IDs are encoded as portable filenames, while
the original IDs remain in the JSON. Writes are serialized within each
FileTransport instance, and `close()` waits for pending writes.

For another destination, implement the exported `LogTransport` contract:

```ts
interface LogTransport {
  write(entry: LogEntry): void | Promise<void>;
  close?(): void | Promise<void>;
}
```

LoggerPlugin owns its transports and calls optional `close()` on cleanup. A
failed transport is reported through diagnostics without preventing other
transports from receiving the entry. Custom transport implementations choose
their authentication, payload format and destination. See the
[custom transport example](../../examples/guide/plugins.md#custom-log-transports).
`LoggerOptions.write` has been removed; provide a transport instead.

This is an early 0.x release. See the
[repository](https://github.com/tessar-ai/tessar) for usage and contracts.
