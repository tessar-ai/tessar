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
npx @tessar/cli dev
```

The CLI loads that default export, reads the project's optional `.env`, registers
the HTTP routes on Fastify and listens on `127.0.0.1:4117`. It supports local TypeScript files with
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

Optional self-host configuration contains `hostname`, `port`, `prefix`,
`openapiPath`, `auth`, `fastifyOptions` and `configure`. Port defaults to `4117`. `port: 0`
selects a free port. The CLI handles SIGINT/SIGTERM, stops HTTP/SSE, then calls
`tessar.shutdown()`. Startup failures print the original exception and exit nonzero.
Borrowed database connections remain developer-owned.

```ts
export default new Tessar({
  agents: [assistant],
  server: {
    prefix: "/tessar",
    fastifyOptions: { logger: true },
    configure(app) {
      app.addHook("onRequest", async (_request, reply) => {
        reply.header("x-service", "assistant");
      });
      app.get("/health", async () => ({ ok: true }));
    },
  },
});
```

`fastifyOptions` goes to the Fastify constructor. `configure(app)` runs before
listening in the configured prefix and accepts native routes, plugins, hooks,
schemas, decorators and error handlers. A hook added directly to `app` applies
to built-in endpoints below that scope. Registered plugins use Fastify's own
encapsulation rules. Install the Fastify plugins your project uses. The CLI
owns listening and shutdown. See [Fastify Server](https://fastify.dev/docs/latest/Reference/Server/).

Move old self-host `server.routes` and `server.middlewares` into `configure`,
using Fastify route and hook signatures. Existing applications register custom
routes and middleware with their framework.

## Existing applications

Fastify, Express and Hono adapters expose the same built-in API and OpenAPI JSON document.
The application owns auth, middleware ordering, the HTTP listener and its port.
Adapters never call `listen()` or change `process.exitCode`.

```ts
import Fastify from "fastify";
import { TessarServer } from "@tessar/server/fastify";
import { tessar } from "./tessar.js";

const app = Fastify();
// Register the application's hooks, plugins and routes here.
const server = new TessarServer({ app, tessar, prefix: "/tessar" });
await server.init();
await app.listen({ port: 3000 });
```

The Fastify adapter registers the Tessar routes in a Fastify plugin under `prefix`.
Call `init()` before the application boots. The parent Fastify scope supplies hooks
and body limits. `app.close()` ends Tessar SSE through a Fastify lifecycle hook.
Call `tessar.shutdown()` when the application is ready to dispose the runtime.

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

Your application supplies Express or Hono. Both frameworks are optional peers.
For Hono use `TessarServer` from `@tessar/server/hono`, pass your Hono app,
call `await server.init()`, then use your application's Hono serving mechanism.
Run the application with its normal command.

`server.init()` registers routes or a request handler after runtime initialization.
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
The Agent abort route can also cancel an execution waiting for approval after its
response has ended, as long as the current runtime still holds that execution.
For persisted work after restart, use the Session API.
Idle Session handles use a least-recently-used cache capped at 100 handles and
16 MiB of estimated serialized state/metadata. Requests, SSE viewers, unfinished
executions, interruptions and queued input keep their handles pinned. Eviction
disposes the local handle; persisted Session/Thread data remains available for restoration.
These are idle-cache limits, not a total memory limit for active work or storage.
Slow viewers retain only one pending latest snapshot. Direct Agent SSE keeps
draining the SDK iterator after the viewer disconnects.
If the SDK iterator exceeds its event buffer, SSE ends with a viewer-local
`failed` state containing `ConsumerTooSlow`. This does not abort the execution or
change its persisted status; a Session can still read its actual state/result.
Pending input capacity errors return HTTP 429 with code `InputQueueFull`; rejected
input is not admitted. Tessar shutdown clears cached handles and ends Session viewers.

Built-in JSON endpoints limit request bodies to 16 MiB of UTF-8 bytes and return
HTTP 413 with code `PayloadTooLarge` above that limit. Streaming reads enforce the
limit even without Content-Length or when its value understates the body size.
The counting boundary is installed before Tessar middleware/auth, including request
clones read by auth callbacks. This is separate from the 4 MiB pending-input budget.
Express or developer middleware that parses a body before entering Tessar must
enforce its own read limit; custom routes remain developer-owned.

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
