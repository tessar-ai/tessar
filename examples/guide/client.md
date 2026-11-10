# Using a remote Tessar runtime

`@tessar/client` wraps the HTTP/SSE APIs exposed by `@tessar/server`. Your frontend or other client application does not need to construct an Agent, Controller or Tessar server. Install only `@tessar/client`; the package has no runtime/peer dependencies and does not install core, server or zod. Its error class extends native `Error`, with client-owned JSON protocol types.

```ts
import { TessarClient, TessarClientError } from "@tessar/client";

const client = new TessarClient({
  baseURL: "http://localhost:4117", // include the integration prefix if configured
  headers: { Authorization: "Bearer ..." },
});
```

The application supplies authentication. For cookies, configure `credentials: "include"`; for another browser origin, the server must permit that origin, headers and credentials through its CORS policy. The SDK does not change server authentication or CORS. To refresh tokens, use the optional native-compatible fetch override or construct a new client; configured headers are snapshotted when the client is created.

## Agent or conversation

Use direct Agent execution for an independent request:

```ts
const agents = await client.listAgents();
const agent = client.getAgent(agents[0]!.id);
const stop = new AbortController();

for await (const event of await agent.stream("Summarize this topic", { signal: stop.signal })) {
  console.log(event.payload.state);
}
```

This does not create a Controller or a Session. Each direct Agent call creates a new Thread. A continuing conversation uses a Controller that the server developer explicitly registered:

```ts
const controllers = await client.listControllers();
const controller = client.getController(controllers[0]!.id);
const session = await controller.createSession();
const thread = await session.thread.create({ title: "Research" });

const stop = new AbortController();
const events = await session.state.stream({ signal: stop.signal });
const receiving = (async () => {
  try {
    for await (const event of events) {
      console.log(event.payload.state); // replace with the application's render/state update
    }
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  }
})();

await session.followUp("Research this topic");
// Send further user messages through the same session.followUp(...).
// The receiving task continues to observe state across turns.

// Later, when the view closes:
stop.abort();
await receiving;
```

Open observation before submitting input. `followUp` returns a queue receipt, not the assistant's answer. Text, reasoning, tools, pending approvals and execution status arrive in `event.payload.state`. A Session observation stays open between turns; do not treat the previous turn's initial terminal snapshot as completion of a newly submitted message. Observe the new execution/state rather than waiting for any `completed` snapshot.

Closing observation only stops viewing. `await session.abort({ reason: "User stopped" })` explicitly stops the Session execution; `await session.close()` closes the server Session. An Agent execution can be stopped with `agent.abort(streamId, { reason: "User stopped" })`, using the streamId received in event context. There is no automatic retry or input replay on disconnect.

## Threads, reload and model selection

Store the Controller, Session and Thread IDs as appropriate for your application. After reload, handles reference the existing resources:

```ts
const session = client.getController(controllerId).getSession(sessionId);
const info = await session.info();
const state = await session.state.get();
const thread = session.thread.get(threadId);
const history = await thread.getHistory({ limit: 50 });
const models = await session.model.list();

await session.model.switch(models[0]!.id);
await session.thread.switch(threadId);
```

These getters do not instantiate resources or load data until a network method is called. On manual reconnect, `await session.state.stream({ signal })` receives the current server snapshot without resubmitting input or replaying every event. Durable restoration across a server restart depends on the backend registered on the server. Two browser tabs may use independent Sessions and select the same Thread to observe it; switching one Session does not change the other Session's selection. Scope/authorization remain application-owned server policy.

Thread mutation targets are explicit:

```ts
await session.thread.rename("New title", { threadId });
const fork = await session.thread.fork({ threadId });
await session.thread.delete({ threadId: fork.id });
// purge is a separate permanent operation and retains the server's safety checks.
```

Pages retain the server cursor: pass `nextCursor` back as `cursor` rather than assuming all results have been loaded. Thread execution methods expose streams, turns, model attempts, tool executions and interrupts with their existing status filters. Records are independent JSON data:

```ts
const record = await controller.records.append({ namespace: "notes", data: { topic: "RAG" } });
const page = await controller.records.list({ namespace: "notes", limit: 20 });
const saved = await controller.records.get("notes", record.id);
```

## Interruptions and failures

For a Session pending interruption, show the interruption payload/schema from state and submit the user's answer through `session.resume({ interruptId, value })`. `session.recover({ streamId })` invokes the server's explicit recovery operation. Independent Agent continuation uses `await agent.resume({ threadId, interruptId, value })`, returning another finite state stream. No local plugin execution is involved.

```ts
try {
  await session.followUp("Continue");
} catch (error) {
  if (TessarClientError.isInstance(error)) {
    console.error(error.status, error.remote?.code ?? error.code, error.message);
  } else {
    throw error; // native network/abort failure
  }
}
```

A successful request can still report a failed runtime state: check `state.status` and `state.error`. The server may instead return an HTTP failure for `generate`; the SDK preserves that distinction. Closing an SSE response is not a success signal. When a mutation's connection fails, inspect state/queue/history before deciding to resend it because the server may already have accepted it.

The SDK includes no UI components or plugin management API. It uses the current server protocol; there is no protocol version negotiation. Real browser CORS/UI end-to-end validation remains outstanding even though the package is browser-bundle compatible.
