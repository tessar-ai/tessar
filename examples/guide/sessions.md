# Controller and Session

[All guides](README.md) · Next: [Storage](storage.md)

A Controller adds plugin and service lifecycle to an Agent. A Session tracks the
selected thread and model, queues follow-ups and exposes events through
`subscribe()`. A thread owns conversation history; a Session can select among
several threads.

Session and Thread IDs can be supplied when creating them. Omit `id` to generate
one; creating an existing ID fails instead of replacing its state:

```ts
const session = await controller.createSession({ id: "chat-42" });
const thread = await session.thread.create({ id: "conversation-42" });
const fork = await session.thread.fork({ id: "conversation-42-copy" });
// fork({ threadId, id }) selects the source with threadId and names the destination with id.
```

Resume and recover retain their existing execution IDs and receipts.
`followUp(messages)` keeps its existing queue receipt `{ id, threadId }`.

## Create and select a Thread

For a new conversation, create and select its Thread in one call:

```ts
const session = await controller.createSession({
  id: "chat-42", threadId: "conversation-42", scope: { userId: "user-42" },
});
```

`threadId` creates a new Thread and inherits the Session scope, exactly like
`await session.thread.create({ id: threadId })`. Existing IDs fail; use
`session.thread.switch(id)` to select an existing Thread. Without `threadId`,
create or select a Thread before calling `followUp()`.

## Render snapshots

Subscribe once and render complete snapshots instead of collecting individual
text deltas or tool events:

```ts
import { stateChanged } from "@tessar/core";

const unsubscribe = session.subscribe(stateChanged, event => {
  render(event.payload.state); // Your terminal renderer or application transport.
});
render(session.state.get());
await session.followUp("Hello");
// Later: unsubscribe();
```

`session.state.get()` synchronously returns the latest immutable snapshot in
memory. `stateChanged` is the string `"state_changed"`; a literal comparison
`event.type === "state_changed"` works as well. The snapshot contains:

- `status`, `error` and the pending `interrupt` when a response is required.
- `messages`, including the accumulated assistant draft, and `currentMessage`
  pointing to that draft until its final message is committed. Render `messages`
  once; do not append `currentMessage` a second time.
- `tools`: execution ID, tool-call ID, name, status, latest progress, result and error.
- `queuedInputs`: follow-ups waiting to start, excluding the current execution.

Text and reasoning appear incrementally. Completed messages remain across
follow-ups. Selecting another Thread replaces the conversation snapshot.
Restoring a Session loads committed messages and any pending interrupt; unfinished
drafts and tool progress are transient. Thread and stream IDs stay on the event;
`session.thread.getId()` returns the selected Thread ID.

`session.followUp.count()` and `session.followUp.isEmpty()` inspect the queue.
`session.isIdle()` means no execution is currently running, including while
suspended and awaiting resume. It does not imply that the queue is empty or the
conversation is finished. `session.isDisposed()` checks the handle's lifecycle;
`controller.isReady()` checks whether initialization completed and it is usable.

Snapshots are projections for rendering, not model context or checkpoints. The
getter does not read storage, and snapshot events do not cause database writes.
Use `session.thread.getHistory()` for explicit history reads. Browser clients
need an application-owned transport; see [client SDK debt](../../docs/technical-debt.md).

## A two-message conversation

Save as `conversation.ts` after the [setup](README.md).

```ts
import { Agent, Controller, text as textEvents, stream } from "@tessar/core";
import { OpenAIProvider } from "@tessar/openai";

const agent = new Agent({
  id: "assistant",
  model: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL!,
  }),
});
const controller = new Controller({ id: "my-app", agent });

try {
  await controller.initialize();
  const session = await controller.createSession({ scope: { userId: "demo-user" } });
  const thread = await session.thread.create({ title: "First conversation" });

  async function ask(text: string): Promise<void> {
    let unsubscribe = () => {};
    const completed = new Promise<void>((resolve, reject) => {
      unsubscribe = session.subscribe(event => {
        if (event.type === textEvents.delta) {
          process.stdout.write(event.payload.delta);
        }
        if (event.type === stream.end) resolve();
        if (event.type === stream.error) reject(Error(event.payload.error.message));
        if (event.type === stream.suspended) reject(Error("Execution needs a resume response"));
      });
    });
    try {
      await session.followUp(text);
      await completed;
      console.log();
    } finally {
      unsubscribe();
    }
  }

  await ask("My name is Alex. Remember it for this conversation.");
  await ask("What is my name?");

  console.log("Session:", session.id, "Thread:", thread.id);
  console.log((await session.thread.getHistory({ limit: 20 })).items);
} finally {
  await controller.dispose();
}
```

```sh
node --env-file=.env conversation.ts
```

The subscription is installed before submitting input. `followUp()` acknowledges
queued input; it does not wait for the model's final answer. The small `ask()`
helper waits for the completion event so this standalone example can close
cleanly. An interactive application normally subscribes once and leaves its
Controller alive across requests.

`followUp(text)` creates a `HumanMessage` internally. You can also pass an explicit
message or a readonly array of messages for metadata, multipart content or context.

You can call `followUp()` while work is running: accepted input waits in the
Session queue. Input that has not yet been admitted is held in memory. Failed or
canceled work can discard queued input; observe Session events in your UI.

## Send a signal to the selected Thread

Keep your existing Session subscription. Send through the Agent using the selected
Thread ID; do not add a second Session sending API:

```ts
const threadId = session.thread.getId();
if (!threadId) throw Error("Select or create a Thread first");

await agent.sendSignal({
  threadId,
  content: "A background task has finished.",
  tagName: "notification",
  attributes: { source: "background" },
  metadata: { taskId: "build-42" },
  persist: true, // default
});
```

Supply exactly one of `threadId` and `streamId`. Use `threadId` for Session work
and `streamId` for direct Agent streams. A running Thread consumes signal input
at the next safe model boundary within its current execution. An idle selected
Thread starts work with that Session's selected model/options, and events reach
the same subscription. Unlike `followUp()`, it does not enqueue a later execution.

The returned Promise acknowledges input in memory, without waiting for execution
startup or persistence. Observe the subscription for execution failures. Input
that has already been committed survives restart with persistent storage.

A suspended Thread retains pending input until explicit `session.resume()`;
signal does not answer its interruption or approve a tool. Committed pending input
survives restart with a persistent backend: restore the Session first, then resume.
`persist: false` input lasts only for that execution in this process.

An idle target needs an unambiguous live Session handle. Multiple live handles
selecting the same Thread are rejected; dispose unused handles. Stale Session
revisions, unavailable Threads and work owned by another process fail explicitly.
Signal is an in-process SDK receiver, not a cross-process message transport.

## Thread operations

These are operations on a Session instance, after initialization:

| API | Behavior |
| --- | --- |
| `session.scope()` | Read the fixed state scope inherited by its threads |
| `session.metadata()` | Read the Session's persisted metadata |
| `session.thread.create({ title })` | Create and select a new thread |
| `session.thread.getId()` | Read the selected thread ID, or `null` |
| `session.thread.get(id)` | Get a thread within the Session's scope |
| `session.thread.list({ limit, cursor })` | Page through threads in scope |
| `session.thread.switch(id)` | Select an existing thread |
| `session.thread.rename(title)` | Rename the selected thread |
| `session.thread.getHistory({ limit, cursor })` | Page through message history |
| `session.thread.fork()` | Create a fork; explicitly switch to its returned ID to select it |
| `session.thread.delete()` | Soft-delete the selected thread |
| `session.abort(reason)` | Abort active work |
| `session.thread.purge({ threadId })` | Permanently remove a previously deleted thread |
| `session.model.get()` | Read the full `providerId/modelId` ID |
| `session.model.name()` | Read the native model ID for display |
| `session.model.list()` | List readonly `{ id, name, profile }` entries |
| `session.model.switch(id, options?)` | Select a model and options for future input |

Thread creation accepts `title`, `messages` and `metadata`; scope comes from the
Session. Instructions belong to Agent or context hooks. Creation and selection
changes are rejected while work is running or input is queued. `fork()` also
accepts an exact `atCheckpointId` or `atMessageId`; a fork point must not contain
unresolved tool calls. History pages return `items` and `nextCursor`.

Controller manages lifecycle, plugins and Sessions. Thread CRUD and model
selection belong to Session; Controller has no `models` or thread CRUD API.
Returned Thread handles provide history, checkpoint, trace and record reads.

## Switch models

```ts
console.log(session.model.get());  // e.g. openai/gpt-6.1-sol
console.log(session.model.name()); // gpt-6.1-sol
console.log(session.model.list()); // [{ id, name, profile }, ...]
await session.model.switch("gpt-6-astra", { reasoning: { effort: "high" } });
// A different provider/connection must first be registered by a plugin:
await session.model.switch("openrouter/anthropic/claude-sonnet-4-6");
```

A bare ID without slashes keeps the current provider/connection. Use a full ID
from `list()` for cross-provider changes or native IDs containing slashes.
Each switch uses the destination provider's configured defaults plus the supplied
shallow overrides. Nested objects replace whole objects; previous Session
overrides are discarded. Omitting options restores destination defaults.
Keys, base URLs, headers, timeouts and retries belong to provider configuration.

An executable model passed to Session creation is retained by its named connection
in the current Controller runtime, including when reopening the Session handle.
After process restart, recreate/register that connection with a stable
`connectionId` and the same endpoint/protocol. Saved state contains references,
not credentials or executable clients. Native opaque provider history may require
the original model; use a new Thread when changing to an incompatible model.

Accepted input retains its model/options snapshot, even while queued. Switches
affect later accepted input; resume/recover use the saved execution selection.
Policies use `session.model.beforeChange`; successful persisted changes emit
`session.modelChanged`. Both include model identities and optional
`previousOptions`/`options`. Denied or failed writes emit no changed event.

Agent and Controller IDs are application-defined and must be unique among live
instances of each kind in one loaded core runtime. Session IDs are generated.
Scope filters state; your backend still owns user authentication and authorization.

The default backend is in memory. See [Storage](storage.md) to restore history
and Session selection after an application restart.

`await controller.dispose()` also closes its Session handles, discards queued
input and publishes `session.closed` before plugin cleanup. Repeated Session
disposal is safe. A public Session close can be refused by its before-close
barrier; parent shutdown reports a barrier failure and still releases the handle.

## Resume a tool question

Tools can [return `context.suspend(payload)`](tools.md#suspend-a-tool-to-ask-the-user)
to wait for user input or approval. Keep your subscription alive while waiting;
`session.resume()` acknowledges the response and subsequent events arrive through
that same subscription. For example, this application helper connects an existing
Session to your UI:

```ts
import { stream as executionEvents, type Session, type JsonValue } from "@tessar/core";

function connectQuestions(
  session: Session,
  render: (interruptId: string, payload: JsonValue) => void,
) {
  const unsubscribe = session.subscribe(executionEvents.suspended, event => {
    render(event.payload.interrupt.id, event.payload.interrupt.payload);
  });
  return {
    submit: (interruptId: string, value: JsonValue) => session.resume({ interruptId, value }),
    unsubscribe,
  };
}
```

Your form handler calls `submit()` with the selected value. Handle a rejected
response in your UI; schema validation errors leave the question pending for a
corrected answer. Queued follow-ups wait until the suspended execution completes.
One Session has one foreground execution; use separate Sessions for concurrent
tabs or jobs. Answering a tool question does not re-run that tool's `execute()`.
