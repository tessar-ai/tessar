# Application plugin examples

Reference implementations for developers reading the repository. Copy a plugin
into your application and adapt its policy. Each file implements one application
concern using public Tessar APIs.

| Plugin | Application use |
| --- | --- |
| [EnvironmentContextPlugin](environment-context.ts) | Give the model current time, time zone and host system information. |
| [ToolApprovalPlugin](tool-approval.ts) | Require a human decision before sending email, deleting data or running another sensitive tool. |

The original [block-write.ts](block-write.ts) remains a minimal fixed-denial policy.

## Register the instances

For your existing Agent:

```ts
const controller = new Controller({
  id: "application",
  agent,
  plugins: [
    new EnvironmentContextPlugin(),
    new ToolApprovalPlugin(["send_email", "delete_document"]),
  ],
});
```

Choose the plugins your application needs. Controller initialization and disposal
follow the [normal lifecycle](../guide/plugins.md).

## Environment context

The plugin adds an instruction section with the current UTC time, the host's
configured time zone, operating system/kernel release, CPU architecture, Node.js
version and working directory. Values are read on each `context.prepare`, keeping
the time fresh while preserving existing instructions and message history.

The information describes the process hosting Tessar. On a server, these are the
server's environment and directory, rather than the browser user's device. The
plugin uses Node.js APIs and does not collect environment variables or credentials.

## Human approval

The plugin intercepts only the configured tool names. It stores a pending
interruption containing the tool name and arguments before the tool effect runs.
Your UI displays that payload and collects the human's decision. It does not ask
the model to approve its own action.

Pass the real user's decision to the existing continuation API:

```ts
const continuation = agent.resume({
  threadId,
  interruptId,
  value: { approved: approvedByUser },
});
```

Consume the returned Stream through your application's existing flow. With a
Session, use `session.resume({ interruptId, value: { approved: approvedByUser } })`.
Invalid responses leave the interruption pending. Approval permits the tool;
rejection returns a denial result to the model. Plugin IDs, interruption versions
and the configured tool set must remain compatible when restoring pending work.
Persistence across restarts uses the Controller's configured backend. The response
schema uses `zod`.

For external side effects, also define the tool's
[recovery/reconciliation contract](../guide/tools.md).

