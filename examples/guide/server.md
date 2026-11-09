# Server and application integration

Create `src/index.ts` and export a Tessar runtime:

```ts
import { Tessar } from "@tessar/server";
import { assistant } from "./agents/assistant.js";

export default new Tessar({ agents: [assistant] });
```

Install `@tessar/server` alongside core and your provider, then run
`npx tessar dev` from the project root. The CLI loads the entry and optional
`.env`, initializes Hono routes and opens `127.0.0.1:4117`. It does not watch or
restart files yet. `new Tessar()` itself never listens.

Agent-only registration does not create a Controller or Session. Each direct Agent
call follows its core lifecycle. For Session/Thread conversations and Controller
plugins/storage, explicitly register a Controller containing that Agent:

```ts
import { Controller } from "@tessar/core";
import { Tessar } from "@tessar/server";
import { assistant } from "./agents/assistant.js";

const support = new Controller({ id: "support", agent: assistant, plugins: [] });
export default new Tessar({ controllers: [support] });
```

Both arrays may be supplied for different Agents. `getAgent(assistant.id)` returns
the original instance even when it belongs to a registered Controller; use
`getController("support")` for its Session API. Do not list the same Agent twice.
Plugin/subagent delegation remains developer-defined and is not automatically
exposed by the server.

Optional `server: { hostname, port, prefix, openapiPath, routes, middlewares }`
configures standalone hosting. Defaults are `127.0.0.1`, `4117`, empty prefix and
`/openapi.json`. Swagger/playground UI is deferred.

For an existing backend, use the same runtime with a built-in adapter:

```ts
import express from "express";
import { TessarServer } from "@tessar/server/express";
import tessar from "./index.js";

const app = express();
app.use(express.json());
const server = new TessarServer({ app, tessar, prefix: "/tessar" });
await server.init();
const listener = app.listen(3000);
```

Hono uses `TessarServer` from `@tessar/server/hono` with the application's Hono app.
The application starts with its existing command and owns auth, middleware and
listening. It shuts down adapter SSE, then its listener, then the runtime via
`tessar.shutdown()`; borrowed database clients remain developer-owned.
With that prefix, APIs start at `/tessar/api` and OpenAPI JSON is served at
`/tessar/openapi.json`. Without prefix, existing `/api/...` paths below apply.

`getAgent(id)` and `getController(id)` return existing runtime instances for direct
SDK use. Session operations remain on Controller/Session. Unsupported frameworks
extend the root `TessarServerAdapter<App>` and implement `registerHandler()` with
Web Request/Response conversion. See the [package README](../../packages/server/README.md)
for ownership, initialization and custom adapter details.

Use `GET /api/controllers` to discover IDs. Create an independent working Session
for each tab/client:

```ts
const base = "http://127.0.0.1:4117";
const controllers = await fetch(`${base}/api/controllers`).then(r => r.json());
const path = `${base}/api/controllers/${encodeURIComponent(controllers[0].id)}`;
const session = await fetch(`${path}/sessions`, {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
}).then(r => r.json());
const sessionPath = `${path}/sessions/${encodeURIComponent(session.id)}`;
await fetch(`${sessionPath}/threads`, {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
});

const events = new EventSource(`${sessionPath}/state/stream`);
events.addEventListener("state_changed", event => {
  const { payload: { state } } = JSON.parse(event.data);
  console.log(state);
});
await fetch(`${sessionPath}/follow-up`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ input: "Hello" }),
});
```

Follow-up returns a 202 admission receipt, not the eventual answer. SSE and
`GET /state` expose the accumulated SDK RuntimeState. Two independent Sessions can
select the same Thread via `POST /thread/switch` with `{ threadId }`, and see its
updates while preserving their own model/Thread selection and queue.

Reconnect never resubmits input or runs recovery. Persisted unfinished work needs
explicit `/resume` or `/recover`; memory storage disappears on restart. Disconnect
only detaches the viewer. `/abort` explicitly cancels the selected execution.

Add application routes and middleware with `registerRoute`/`registerMiddleware`;
keep their handlers in separate modules. The [package README](../../packages/server/README.md)
documents registration, route inventory, lifecycle and errors. Application auth,
authorization and UI remain developer choices. A packaged CLI can start this host
locally and call HTTP/SSE, or use the SDK directly without a server.
For typed remote access from a frontend or Node application, see the
[@tessar/client guide](client.md).
