# @tessar/client

Typed HTTP/SSE access to a Tessar server from a browser or Node.js. Uses native fetch; no UI framework dependency.

```sh
pnpm add @tessar/client
```

```ts
import { TessarClient } from "@tessar/client";

const client = new TessarClient({
  baseURL: "http://localhost:4117",
  // headers: { Authorization: "Bearer ..." },
  // credentials: "include", // for browser cookie authentication
});

const agents = await client.listAgents();
const agent = client.getAgent(agents[0]!.id);
const result = await agent.generate("Hello");

for await (const event of await agent.stream("Explain the result")) {
  console.log(event.payload.state);
}
```

Each direct Agent call starts its own execution with a new Thread. For a continuing conversation, use an explicitly registered Controller and Session, described in the [client guide](../../examples/guide/client.md).

## Configuration and resources

`baseURL` is required and includes any integration prefix: `https://example.com/tessar` calls `/tessar/api/...`. Optional `headers`, `credentials` and a native-compatible `fetch` override apply to JSON and SSE requests. Authentication and CORS policy belong to the application/server. This package has no runtime or peer dependencies: installing it does not install `@tessar/core`, `@tessar/server` or `zod`. Its JSON request/response types are self-contained; core is used only as a compatibility oracle in repository tests.

`getAgent`, `getController`, `controller.getSession` and `session.thread.get` construct local handles without fetching or creating server resources. Call `info()` to fetch their descriptors. `createSession` and thread `create/switch/fork` return handles using the response ID without a second request. Lists retain the server's arrays or `{ items, nextCursor }` pages.

| Resource | Methods |
| --- | --- |
| Client | listAgents, getAgent, listControllers, getController |
| Agent | info, listTool, generate, stream, resume, sendSignal, abort |
| Controller | info, createSession, getSession, listSessions; records.append/get/list |
| Session | info, close, followUp, resume, recover, abort; queue.info; model.info/list/switch/setEffort; state.get/stream |
| Session thread | create, get, list, switch, rename, fork, delete, purge |
| Thread | info, snapshot, getHistory, listCheckpoints, getCheckpoint, getStream, getInterrupt, listStreams, listTurns, listModelAttempts, listToolExecutions, listInterrupts |

All network operations accept an optional `signal`, combined with domain options where present. Inputs contain JSON data, model IDs/refs and encoded messages, not executable plugins/model adapters. Responses are JSON DTOs, not core class instances. Execution and record timestamps remain strings.

## Streams and errors

`await agent.stream(...)`, `await agent.resume(...)` and `await session.state.stream(...)` eagerly open the connection and return a single-consumer `AsyncIterable<StateEvent>`. Each event carries a complete `payload.state`, including current text/reasoning, tool activity, interruption and execution error. Inspect it directly; no token reducer is required. Open Session observation before submitting `followUp`.

Breaking iteration or aborting the request signal closes the local connection. It does not abort server execution. Use `session.abort({ reason })` or `agent.abort(streamId, { reason })` to stop work. Use an AbortSignal to close an eagerly opened stream even if iteration has not begun. Agent streams end at response EOF; Session observation normally stays open. Consume promptly or cancel when the view is destroyed.

HTTP/protocol failures throw `TessarClientError` with `code`, optional `status` and optional `remote` ErrorInfo. It extends native `Error`, with `isInstance()` and `toJSON()`; it does not inherit from backend `TessarError`. Native network and abort errors retain their original identity. Failed executions in successful JSON/state responses remain data; inspect `error` and `status`. The current server may also return a provider failure from `generate` as an HTTP error. SSE EOF alone is not proof of execution success.

No automatic retries, reconnects or mutation replay. After reconnecting to the same Session, the server sends its current state; it does not replay every intermediate event. A disconnected mutation may already have been admitted: inspect server state instead of blindly resending it.

The SDK follows the current Tessar HTTP API, which has no version negotiation. Browser bundle and Web API behavior are tested; a real browser UI end-to-end flow remains part of TD-002. UI components, AI SDK adapters and plugin installation/management are outside this package.
