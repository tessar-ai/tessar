# Persistent conversations

[All guides](README.md) · Prerequisite: [Controller and Session](sessions.md)

Core manages state, history, checkpoints and execution records. A storage plugin
chooses where they live. In-memory storage is the default; select one durable
backend for a Controller before initializing it.

Automatically generated IDs are plain UUIDs, without prefixes such as `session_`
or `thread_`. Explicit IDs supplied by applications and IDs already stored are
preserved.

Physical storage names use the `tessar_` prefix, for example `tessar_sessions`,
`tessar_threads`, `tessar_checkpoints` and `tessar_messages`. PostgreSQL keeps
these tables inside the configured schema; MongoDB collections already use this
prefix. Public API names such as `threads` and `model_attempts` are unchanged.
The current physical layouts are the initial schema v1 for each backend.

## SQLite: restore a Session after restart

```sh
npm install @tessar/sqlite
```

Save as `storage.ts`. The same database, Agent ID and model connection identity
are used each time the application starts.

```ts
import { Agent, Controller, text as textEvents, stream } from "@tessar/core";
import { OpenAIProvider } from "@tessar/openai";
import { SqliteStoragePlugin } from "@tessar/sqlite";

const agent = new Agent({
  id: "assistant",
  model: new OpenAIProvider({
    connectionId: "primary-openai",
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL!,
  }),
});
const controller = new Controller({
  id: "my-app",
  agent,
  plugins: [new SqliteStoragePlugin({ filename: "./state.db" })],
});

try {
  await controller.initialize();
  const scope = { userId: "demo-user" };
  const savedId = process.argv[2];
  const session = savedId
    ? await controller.getSession(savedId, { scope })
    : await controller.createSession({ scope });
  if (!session) throw Error("Session not found in this scope");
  if (!session.thread.getId()) await session.thread.create({ title: "Saved chat" });
  console.log("Save this Session ID:", session.id);
  console.log("Previous messages:", (await session.thread.getHistory()).items);

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
    await session.followUp(process.argv[3] ?? "Hello again.");
    await completed;
    console.log();
  } finally {
    unsubscribe();
  }
} finally {
  await controller.dispose();
}
```

Create a Session on the first run:

```sh
node --env-file=.env storage.ts
```

On a later run, replace `SESSION_ID` with the printed ID:

```sh
node --env-file=.env storage.ts SESSION_ID "What did we discuss?"
```

`getSession()` restores the saved selection. Use the original nonsecret
`connectionId` with the same provider endpoint and protocol; regenerating a random
connection ID is not a durable model binding. A successful restart after a
completed execution differs from recovering work interrupted by a crash.

## Choose another backend

Replace the SQLite import and the plugin instance in the preceding example with
one of these alternatives; do not register several storage backends together.

PostgreSQL (`npm install @tessar/postgresql`):

```ts
import { PostgresqlStoragePlugin } from "@tessar/postgresql";

const storage = new PostgresqlStoragePlugin({
  connectionString: process.env.POSTGRES_URL!,
  schema: "tessar",
  driverOptions: { max: 10 },
});
// In Controller options: plugins: [storage]
```

MongoDB (`npm install @tessar/mongodb`):

```ts
import { MongoDBStoragePlugin } from "@tessar/mongodb";

const storage = new MongoDBStoragePlugin({
  uri: process.env.MONGODB_URL!,
  databaseName: "my_agent",
  clientOptions: { maxPoolSize: 10 },
});
// In Controller options: plugins: [storage]
```

MongoDB needs a replica set or sharded deployment supporting transactions. The
Controller owns storage plugin cleanup, including database connections.

## Read state through public APIs

| API | Data |
| --- | --- |
| `controller.listSessions({ scope })` | Stored Sessions for this Agent |
| `session.thread.list()` | Threads within the Session scope |
| `session.thread.getHistory()` | Message history, including tool calls/results |
| `thread.snapshot()` | Current checkpoint state and aggregate usage |
| `thread.listCheckpoints()` | Checkpoint history |
| `thread.listStreams()` | Executions belonging to the thread |
| `thread.listTurns(streamId)` | Turns within an execution |
| `thread.listModelAttempts(turnId)` | Model attempts, usage and errors |
| `thread.listToolExecutions(turnId)` | Tool execution records |

Page APIs expose `items` and `nextCursor`. Fetch the next page with that cursor.
Usage fields are available when reported by the provider; missing values are
not zero. A thread's retained history and the context you send to a model are
separate concerns: plugins can transform the outgoing request at `context.prepare`.

Checkpointed plugin JSON state uses Tessar's state APIs and selected backend.
Plugins needing their own searchable tables or job queues can own a separate
database/schema and its migrations. Storage plugins do not expose a generic SQL
connection through the plugin API.
