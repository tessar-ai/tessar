# Standalone server

Install `@tessar/server` alongside core and your provider. Your Agent and Controller
configuration stays the same. Add a host in your application's composition file:

```ts
import { Tessar } from "@tessar/server";
import { support } from "./controllers/support.js";

export const tessar = new Tessar({ controllers: [support] });
```

It listens at `http://127.0.0.1:3000`. Optional `server.hostname` and `server.port`
override the address. The owning process calls `await tessar.close()` on shutdown.
This disposes runtimes but never closes borrowed database clients.

Use `GET /api/controllers` to discover IDs. Create an independent working Session
for each tab/client:

```ts
const base = "http://127.0.0.1:3000";
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
