# Persistent conversations

[All guides](README.md) · Prerequisite: [Controller and Session](sessions.md)

Core manages state, history, checkpoints and execution records. A storage plugin
chooses where they live. In-memory storage is the default; select one durable
backend for a Controller before initializing it.

Automatically generated IDs are plain UUIDs, without prefixes such as `session_`
or `thread_`. Explicit IDs supplied by applications and IDs already stored are
preserved.

Physical storage names default to `tessar_*`. For MongoDB and libSQL, optional
`namespace: "app"` produces names such as `app_tessar_threads`, including scoped
indexes and metadata. MongoDB namespaces must match
`[A-Za-z_][A-Za-z0-9_]{0,62}`; libSQL requires lowercase ASCII
`[a-z_][a-z0-9_]{0,62}` to prevent case-insensitive identifier aliases.
PostgreSQL uses its native schema: `schema: "agent_state"` creates
`agent_state.tessar_threads`; its default schema is `tessar`. Public API names
such as `threads` and `model_attempts` are unchanged.
The current physical layouts are the initial schema v1 for each backend.

## libSQL: restore a Session after restart

```sh
npm install @tessar/libsql libsql@0.5.29
```

The root entry provides state/checkpoint storage without requiring RAG.
Vector storage uses `@tessar/libsql/vector` and requires explicitly installing
the optional peer `@tessar/rag`; see the [RAG guide](./rag.md).

Save as `storage.ts`. The same database, Agent ID and model connection identity
are used each time the application starts.

```ts
import { Agent, Controller, text as textEvents, stream } from "@tessar/core";
import { OpenAIChat } from "@tessar/openai";
import Database from "libsql";
import { LibsqlStoragePlugin } from "@tessar/libsql";

const agent = new Agent({
  id: "assistant",
  model: new OpenAIChat({
    connectionId: "primary-openai",
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL!,
  }),
});
const database = new Database("./state.db");
const controller = new Controller({
  id: "my-app",
  agent,
  plugins: [new LibsqlStoragePlugin({ database })],
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
  try {
    await controller.dispose();
  } finally {
    database.close();
  }
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

Replace the libSQL import, database creation, plugin and native cleanup in the
preceding example with one of these alternatives; do not register several
storage backends together.

PostgreSQL (`npm install @tessar/postgresql pg@^8.16.3`; TypeScript users also
install `@types/pg` as a development dependency):

```ts
import { Pool } from "pg";
import { PostgresqlStoragePlugin } from "@tessar/postgresql";

const pool = new Pool({ connectionString: process.env.POSTGRES_URL!, max: 10 });
const storage = new PostgresqlStoragePlugin({ pool, schema: "agent_state" });
// In Controller options: plugins: [storage]
// After disposing the Controller, await pool.end().
```

MongoDB (`npm install @tessar/mongodb mongodb@^6.21.0`):

```ts
import { MongoClient } from "mongodb";
import { MongoDBStoragePlugin } from "@tessar/mongodb";

const client = new MongoClient(process.env.MONGODB_URL!, { maxPoolSize: 10 });
await client.connect();
const storage = new MongoDBStoragePlugin({
  database: client.db("my_agent"),
  namespace: "app",
});
// In Controller options: plugins: [storage]
// After disposing the Controller, await client.close().
```

MongoDB needs a replica set or sharded deployment supporting transactions.
Native drivers are optional peer dependencies installed explicitly by consumers,
and development dependencies for adapter tests; core remains a runtime dependency.
The application configures, owns and closes its database/client/pool, including
after initialization failure. Controller disposal cleans up the storage plugin;
backend `close()` is a no-op for these borrowed connections. Per-operation
MongoDB transaction sessions and borrowed PostgreSQL pool clients are still
cleaned up. Keep native connections open until all users finish.

Configure remote libSQL authentication and replicas on the native `Database`;
call its `sync()` directly. Tessar does not override `journal_mode` or
`busy_timeout` or write global `PRAGMA user_version`. It enables foreign keys
and records schema v1 in a namespaced `tessar_schema` table, retaining existing
data. Live remote deployments have not been verified.

## Read state through public APIs

| API | Data |
| --- | --- |
| `controller.listSessions({ scope })` | Stored Sessions for this Agent |
| `session.thread.list()` | Threads within the Session scope |
| `session.thread.getHistory()` | Message history, including tool calls/results |
| `thread.snapshot()` | Current checkpoint state and aggregate usage |
| `thread.listCheckpoints()` | Checkpoint history |
| `thread.listStreams()` | Executions belonging to the thread |
| `thread.listTurns()` | Turns across all executions in the Thread |
| `thread.listModelAttempts()` | Model attempts, usage and errors across the Thread |
| `thread.listToolExecutions()` | Tool execution records across the Thread |

Page APIs expose `items` and `nextCursor`. Fetch the next page with that cursor.
The four execution lists accept optional `{ status, limit, cursor }`. Filtering
is applied before pagination. For example:

```ts
const failedTools = await thread.listToolExecutions({ status: "failed", limit: 20 });
const next = failedTools.nextCursor
  ? await thread.listToolExecutions({ status: "failed", cursor: failedTools.nextCursor })
  : null;
```

Status values belong to each record type; for example, successful Streams use
`completed`, while successful tool executions use `succeeded`. Returned records
retain Stream/Turn IDs for inspecting relationships. These methods no longer take
a required Stream/Turn ID; passing the old ID argument is rejected. Scope is fixed
by the Thread handle, and a cursor cannot be reused for another query or Thread.

Usage fields are available when reported by the provider; missing values are
not zero. A thread's retained history and the context you send to a model are
separate concerns: plugins can transform the outgoing request at `context.prepare`.

Checkpointed plugin JSON state uses Tessar's state APIs and selected backend.
Plugins needing their own searchable tables or job queues can own a separate
database/schema and its migrations. Storage plugins do not expose a generic SQL
connection through the plugin API.

## Store independent JSON records

Use `backend.records` when data must be inspected independently of a conversation:
for example, the input and result of a classifier or guardrail. No Agent,
Controller, Session, Thread or checkpoint is required.

```ts
import Database from "libsql";
import { createLibsqlBackend } from "@tessar/libsql";

const database = new Database("./state.db");
try {
  const backend = await createLibsqlBackend({ database });
  try {
    const scope = { userId: "demo-user" };
    const record = await backend.records.append({
      namespace: "decisions",
      scope,
      // id: "application-call-id", // optional; omitted IDs are UUIDs
      data: {
        request: { state: "Deploy failed twice", question: "Escalate?" },
        response: { escalate: true, confidence: 0.97 },
      },
    });
    console.log(await backend.records.get("decisions", record.id, { scope }));
    const page = await backend.records.list({ namespace: "decisions", scope, limit: 20 });
    console.log(page.items);
    if (page.nextCursor) console.log(await backend.records.list({
      namespace: "decisions", scope, limit: 20, cursor: page.nextCursor,
    }));
  } finally {
    await backend.close();
  }
} finally {
  database.close();
}
```

PostgreSQL, MongoDB and the memory backend have the same `records` contract.
libSQL/PostgreSQL use one `tessar_records` table; MongoDB uses one collection.
Each append inserts a record; it does not create another table. Initialization
adds this structure to an existing database without resetting runtime state.

`StoredRecord` contains `id`, `namespace`, `scope`, JSON `data` and an automatically
generated ISO `createdAt`. `(namespace, id)` is unique across scopes. Duplicates
throw `RegistrationConflict`; appending never updates an existing record. List
requires `namespace`, orders ascending by `createdAt` then ID, and returns
`{ items, nextCursor }`. Default limit is 50, allowed range 1–200. Cursors belong
to their namespace/scope query. Omitting scope queries all scopes in that namespace;
applications must supply authorized scope filters for their users.

Record writes commit independently. They are not included in checkpoints,
history, fork, rewind or Thread deletion/purge, and are never automatically sent
to a model. This API does not automatically capture provider calls, implement
retention, or provide arbitrary queries into JSON data. Use plugin state for
current data that must follow execution recovery; use records for independent
entries that must remain available for inspection.

Plugins access the selected backend through `tessar.storage.records` after
Controller initialization. This also works outside an active execution:

```ts
import { ready, type Plugin, type PluginContext } from "@tessar/core";

class StartupAuditPlugin implements Plugin {
  readonly id = "startup-audit";
  setup(tessar: PluginContext): void {
    tessar.hook(ready, async () => {
      await tessar.storage.records.append({
        namespace: "startup-audit",
        data: { action: "application-ready" },
      });
    });
  }
}
```

Capture the storage handle during setup, then call it from a ready hook, a tool,
or application callbacks after initialization. Calling record operations during
setup rejects with `ControllerNotReady`; no storage-plugin registration order is
required. The Controller owns backend cleanup; applications close borrowed native
connections afterward. Without a durable storage plugin,
records use the default memory backend and disappear when it closes.
