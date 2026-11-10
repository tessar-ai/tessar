# @tessar/server

Tessar runtime registration, standalone HTTP/SSE hosting and application adapters.
Requires Node.js >=24.22.1.

Optional `server.auth` accepts an `AuthProvider` and optional `authorize` and `scope`
callbacks. It protects built-in runtime endpoints; custom routes and OpenAPI remain
developer-owned. See the [authentication guide](../../examples/guide/auth.md) for
custom providers and integrations under `integrations/auth/`.

## Runtime and standalone development

Install `@tessar/core`, `@tessar/server` and your provider. Export a Tessar instance
from `src/index.ts`:

```ts
import { Tessar } from "@tessar/server";
import { assistant } from "./agents/assistant.js";

export default new Tessar({ agents: [assistant] });
```

```sh
npx tessar dev
```

The CLI loads that default export, reads the project's optional `.env`, initializes
HTTP routes and listens on `127.0.0.1:4117`. It supports local TypeScript files with
ESM `.js` imports through Node's type transformation. There is no watch/reload,
path-alias resolution, JSX compilation or playground in this release.

`new Tessar()` registers and begins initializing runtimes; it does not open a port.
Register arrays of Agents, Controllers, or both. Independent Agents stay independent;
Tessar never creates Controllers or Sessions for them. Controllers retain their
existing one-Agent core relationship and configured plugins/storage. Do not register
the same Agent separately and through a Controller. Plugin-registered subagents are
not automatically exposed as server resources.

`tessar.getAgent(id)` and `tessar.getController(id)` return the registered instances,
including Controller-owned Agents. Missing IDs throw `TessarServerError` with
`AgentNotFound` or `ControllerNotFound`. For SDK use before adapter initialization,
await the Controller's existing `initialize()` method before executing operations
on a Controller-owned Agent. Independent Agents use their normal core lifecycle.
Agent descriptors omit `controllerId` when no Controller is registered for them.
`/api/controllers` lists only explicitly registered Controllers; Session, Thread
and records APIs require one. Direct independent Agent calls do not gain Session
queues, persisted conversation history or model selection from an implicit host.
`tessar.shutdown()` disposes explicit Controllers and shuts down independent Agents.

Optional `server` configuration on Tessar contains `hostname`, `port`, `prefix`,
`openapiPath`, `routes`, `middlewares` and `auth`. Port defaults to `4117`; `port: 0`
selects a free port. The CLI handles SIGINT/SIGTERM, stops HTTP/SSE, then calls
`tessar.shutdown()`. Startup failures print the original exception and exit nonzero.
Borrowed database connections remain developer-owned.

## Existing applications

Express and Hono adapters expose the same built-in API and OpenAPI JSON document.
The application owns auth, middleware ordering, the HTTP listener and its port.
Adapters never call `listen()` or change `process.exitCode`.

```ts
import express from "express";
import { TessarServer } from "@tessar/server/express";
import { tessar } from "./tessar.js";

const app = express();
app.use(express.json());
// Register application auth/middleware here.
const server = new TessarServer({ app, tessar, prefix: "/tessar" });
await server.init();
app.get("/health", (_, response) => response.json({ ok: true }));
const listener = app.listen(3000);
```

Install Express yourself. Importing the root package or Hono adapter does not load
Express. For Hono use `TessarServer` from `@tessar/server/hono`, pass your Hono app,
call `await server.init()`, then use your application's Hono serving mechanism.
Run either application with its normal command, not `tessar dev`.

`server.init()` registers one handler and resolves only after runtime initialization.
Repeated calls share initialization; failures reject. Shutdown is idempotent and
prevents further requests through the adapter (503); it does not remove framework
middleware, close the application listener, dispose shared runtime or abort SDK
execution. Re-initializing a shut-down adapter rejects. At application shutdown,
close SSE with `await server.shutdown()`, stop your listener, then
`await tessar.shutdown()`. Close your own database client last.

`prefix` defaults to empty. With `prefix: "/tessar"`, the Agents endpoint is
`/tessar/api/agents`. `openapiPath` defaults to `/openapi.json`, so the document is
`/tessar/openapi.json`. Paths must start with `/`, contain no query/fragment or
trailing slash, and OpenAPI must be outside `/api`. Omitted options use the Tessar
server configuration. OpenAPI 3.1 describes built-in routes, parameters, request
bodies, success/error responses and SSE. Provider-specific payloads remain open
objects. Custom application routes are not automatically documented. Swagger UI
is deferred to the self-hosted playground work.

## Custom adapters

Unsupported frameworks extend the root export; no separate adapter package is required:

```ts
import { TessarServerAdapter, type TessarRequestHandler } from "@tessar/server";

class CustomServer extends TessarServerAdapter<MyApp> {
  protected registerHandler(handler: TessarRequestHandler): void {
    // Register with this.app, converting its requests to standard Web Request
    // and writing the returned Response, including streamed bodies.
  }
}
```

The base class supplies `protected accepts(pathname)` to select only Tessar paths;
other requests must continue through the application. Preserve URL/method/headers,
body and cancellation, then response status/headers, streaming and backpressure.
When JSON parsing middleware already consumed the body, rebuild it from the parsed
value. The built-in Express bridge covers both parsed and raw request bodies.
A client disconnect detaches an SSE viewer; it does not abort or replay execution.

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
No RAG, browser UI, authentication service or CLI watch mode is added by this package.
Remote consumers can use the separate [@tessar/client](../client/README.md) HTTP/SSE SDK.

See the [server guide](../../examples/guide/server.md) for a complete usage flow.

Server-owned validation and resource errors use the exported `TessarServerError`,
which extends `TessarError` from core. Core, provider and I/O exceptions retain
their original types and origins; HTTP responses use the safe serialization above.
