# @tessar/logger

Standalone structured logging plugin for Tessar. Requires Node 24.22.1 or newer.

```sh
npm install @tessar/core @tessar/logger
```

```ts
import { Controller } from "@tessar/core";
import { LoggerPlugin } from "@tessar/logger";

const controller = new Controller({
  id: "app",
  agent,
  plugins: [new LoggerPlugin()],
});
```

For a managed installation, call `manager.install("@tessar/logger")` with the
`PluginManager` from `@tessar/core/plugin`. The default export is a configured
logger instance that loads by package name. See the
[plugin guide](../../examples/guide/plugins.md#load-plugins-after-packaging-your-cli).

## Logger transports

Logger writes JSON lifecycle/error entries to stderr by default. Configure its
minimum level and destinations through `transports`:

```ts
import {
  LoggerPlugin, ConsoleTransport, FileTransport, logGroup,
} from "@tessar/logger";

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
