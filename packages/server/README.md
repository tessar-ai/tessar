# @tessar/server

Standalone HTTP/SSE hosting for Tessar on Node.js >=24.22.1.

```sh
npm install @tessar/core @tessar/server
```

```ts
import { Tessar, registerRoute, registerMiddleware } from "@tessar/server";
import { assistant } from "./agents/assistant.js";
import { health } from "./handlers/health.js";

const tessar = new Tessar({
  agents: [assistant],
  server: {
    middlewares: [registerMiddleware("/api/*", async (c, next) => {
      // Application authentication/authorization belongs here.
      await next();
    })],
    routes: [registerRoute("/health", { method: "GET", handler: health })],
  },
});
```

`new Tessar()` initializes the registered runtimes and starts listening. Register
`agents`, `controllers`, or both; at least one runtime is required. Standalone
Agents get a managed Controller with the Agent ID. Agents already supplied through
a Controller must not be registered again. Supplied Controllers retain their plugins.

All server options are optional: `hostname` defaults to `127.0.0.1`, `port` to
`3000`, and route/middleware arrays to empty. `port: 0` chooses an available port;
the listening URL is printed after successful bootstrap. No `ready()` call is needed.
Invalid configuration throws synchronously. Initialization/listening failures
print the original error, dispose acquired runtimes and set `process.exitCode = 1`.

`await tessar.close()` stops serving and disposes managed Controllers, including
those passed in. It is idempotent and may be called during initialization.
Developer-owned database connections remain developer-owned. The host installs
no process signal handlers; the launcher decides when to call `close()`.

## Custom handlers

Keep composition and application logic in separate modules:

```ts
// handlers/health.ts
import type { RouteHandler } from "@tessar/server";
export const health: RouteHandler = c => c.json({ status: "ok" });
```

Handlers receive Hono's native context; import `RouteHandler` and
`MiddlewareHandler` from this package. Routes accept GET, POST, PUT, PATCH, DELETE,
OPTIONS and HEAD. Middleware matches its declared path, runs top to bottom, and
unwinds after `await next()`. Returning a Response short-circuits later handlers.
It applies to both SDK and custom routes. Built-in routes are registered first;
custom exact method/path collisions are rejected before initialization.

## HTTP resources

SDK JSON results retain their shapes: arrays, `{ items, nextCursor }` pages,
`RuntimeState` and `GenerateOutcome`. Class handles become explicit descriptors.
Commands accept JSON, IDs are path segments, and list options are query parameters.
Structured `scope` is JSON encoded. Created resources return 201, admission
receipts 202, successful void operations 204. Errors return `{ error: ErrorInfo }`.
Provider failures map to 502, storage unavailable to 503, conflicts/busy to 409,
missing resources to 404 and invalid requests to 400. Unexpected failures return
a generic public message; diagnostics retain the original exception.
The same safe ErrorInfo serialization applies to state, SSE, generation outcomes
and execution records. Closing or invalidating a Session ends its SSE connections;
reconnect restores the current handle without replaying failed input.

| Namespace | Operations |
| --- | --- |
| `/api/agents` | List; `/:agentId` configuration; `/tools`; POST `/generate`, `/stream`, `/resume`, `/signals`; POST `/streams/:streamId/abort` |
| `/api/controllers` | List; `/:controllerId` configuration |
| `/api/controllers/:controllerId/sessions` | GET list; POST create; `/:sessionId` descriptor |
| Session suffix | POST `/close`, `/follow-up`, `/resume`, `/recover`, `/abort`; GET `/state`, `/state/stream`, `/queue`, `/model`, `/models`; POST `/model/switch`, `/model/effort` |
| Session `/threads` | GET list; POST create; `/:threadId` descriptor; POST Session `/thread/switch` |
| Thread suffix | POST `/rename`, `/fork`, `/purge`; DELETE Thread; GET `/snapshot`, `/history`, `/checkpoints`, `/streams`, `/turns`, `/model-attempts`, `/tool-executions`, `/interrupts` |
| Thread item suffix | GET `/checkpoints/:checkpointId`, `/streams/:streamId`, `/interrupts/:interruptId` |
| Controller `/records/:namespace` | POST append; GET list; GET `/:recordId` |

History accepts `limit`, `cursor` and `atCheckpointId`. Execution lists accept
`status`, `limit` and `cursor`, with the SDK's existing bounds and cursor binding.

Session input queues and selections are independent. Sessions selecting the same
Thread see its admitted execution state. SSE sends `event: state_changed` with
an EventEnvelope containing `payload.state`, followed by current updates.
Reconnect receives a fresh snapshot; event IDs are observation markers, not replay
cursors. Disconnecting never aborts/replays execution. Explicit abort is separate.
Slow viewers retain only one pending latest snapshot. Direct Agent SSE keeps
draining the SDK iterator after the viewer disconnects.

Memory storage is lost on restart. Durable storage restores persisted data;
unfinished work requires explicit resume/recover. HTTP accepts JSON model IDs/refs,
not executable adapters, callbacks or AbortSignal. Constructors, plugins/hooks,
Controller lifecycle and Thread handle disposal remain local configuration.
No RAG, browser UI, client SDK, authentication service or CLI watch mode is added.

See the [server guide](../../examples/guide/server.md) for a complete usage flow.
