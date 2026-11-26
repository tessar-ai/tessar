# @tessar/workspace

Configure a local workspace to give an agent tools for reading and editing its
project and running shell commands. Tool calls start from `root`. Register the
tools through `WorkspacePlugin` or individually on an Agent.

Install with `npm install @tessar/workspace`. The release includes prebuilt Rust
addons for x64 and arm64 on Windows, macOS, and Linux with glibc 2.35 or newer.
Node loads the matching addon on first use of a file tool. Rust and Cargo are required when
building Tessar from source.

## Controller plugin

```ts
import { Agent, Controller } from "@tessar/core";
import { WorkspacePlugin } from "@tessar/workspace";

const agent = new Agent({ id: "workspace-editor", model });
const controller = new Controller({
  id: "workspace",
  agent,
  plugins: [new WorkspacePlugin(process.cwd())],
});

await controller.initialize();
```

The plugin registers `apply_patch`, `edit_file`, `read_file` and `exec_command` during
Controller initialization. Set per-tool options in the optional second argument.

```ts
const workspace = new WorkspacePlugin(root, {
  tools: {
    apply_patch: false,
    edit_file: { name: "update_file", reconcile: checkEdit },
  },
});
```

Set a tool to `false` to disable it. `name` changes the name advertised to
the model. `reconcile` takes the callback for that tool. Tools omitted from
`options.tools` use their original names and default settings.

## Standalone Agent

Register the factories you need through `Agent.tools`.

```ts
import { Agent } from "@tessar/core";
import { createEditFile, createReadFile } from "@tessar/workspace";

const agent = new Agent({
  id: "workspace-editor",
  model,
  tools: {
    read_file: createReadFile({ root: process.cwd() }),
    edit_file: createEditFile({ root: process.cwd() }),
  },
});
```

Each key in `Agent.tools` is the name advertised to the model. For example,
`tools: { update_file: createEditFile({ root, reconcileEdit: checkEdit }) }`
registers the edit tool under `update_file` with a recovery callback.

## `exec_command`

Run a shell command in the workspace root and wait for it to exit. The model
supplies `command` and a brief `reason`. The reason is available to `tool.before`
for policy and approvals.

```json
{ "command": "pnpm test", "reason": "Verify the changes to the order tests" }
```

The result contains `stdout`, `stderr`, `exitCode` and `truncated`. A nonzero
`exitCode` reports command failure. If a signal ended the command, `exitCode`
is `null`. The tool keeps the last 2,000 lines or 50 KiB across both streams by
default, whichever limit is reached first. It drains all output from the child
process and sets `truncated` to `true` when it drops output. It favors complete
lines and keeps a partial tail if no complete line fits. Output is decoded as
UTF-8.

The tool uses Node.js's default shell on the machine running Tessar. This is
`%ComSpec%` (falling back to `cmd.exe`) on Windows and `/bin/sh` on macOS and
Linux. Set `shell` to select a different executable, `timeoutMs` to set the
execution deadline (default 30,000 ms), and
`maxOutputBytes` to change the shared byte cap. A timeout
throws `CommandTimeout`. An abort uses the supplied `AbortSignal` reason.

```ts
const workspace = new WorkspacePlugin(root, {
  tools: { exec_command: { timeoutMs: 60_000 } },
});

// Or register only this tool on an Agent.
const tools = { exec_command: createExecCommand({ root, timeoutMs: 60_000 }) };
```

Set `tools.exec_command` to `false` to disable it on the plugin. Commands run
with the host application's permissions and environment.

## `read_file`

Read a UTF-8 text file using a workspace-relative `path` and optional
`startLine` and `limit`. Line numbers start at 1. Each page returns up to
2,000 lines or 50 KiB of text, whichever comes first. Set `limit` to read
fewer lines.

```json
{ "path": "src/orders.ts", "startLine": 40, "limit": 20 }
```

The result is `{ text, nextLine }`. `text` preserves LF and CRLF line endings.
Pass `nextLine` as `startLine` to read again. A `null` value marks EOF.
Each page ends at a complete line.
If the first requested line exceeds 50 KiB, the tool reports `InvalidRead`
with its line number. The Rust reader scans incrementally, checks cancellation
between reads and allows concurrent readers.

## `apply_patch`

The tool accepts `{ patch: string }` and returns `{ paths: string[] }` containing the paths it changed. For example, an Agent can update a file and create a test in the same call.

```diff
*** Begin Patch
*** Update File: src/orders.ts
@@
-const status = "pending";
+const status = "paid";
*** Add File: test/orders.test.ts
+import "../src/orders.js";
*** End Patch
```

Use paths relative to `root`. A new file can create missing parent directories. An update matches exact text using the unchanged context lines (prefixed by a space) and the removed lines. Hunks are ordered within a file. The tool checks all changes before writing and reports missing or ambiguous context. It preserves the existing file's UTF-8 BOM and line endings.

The OpenAI adapter sends `apply_patch` as a Tessar function tool.

### Recover an interrupted patch

Set `tools.apply_patch.reconcile` on `WorkspacePlugin` or pass
`reconcilePatch` to `createApplyPatch`. On recovery,
Tessar validates the patch targets in the workspace and calls the callback
with the original `patch` and `toolExecutionId`. The callback can return one
of three decisions.

| Decision | Result |
| --- | --- |
| `{ status: "completed", paths }` | The application confirmed every change. Provide all workspace-relative paths using `/`. Tessar restores the tool result in patch order and continues the original stream. |
| `{ status: "safeToRetry" }` | The application verified that the whole original patch can run again safely. Tessar runs it once and continues the stream. |
| `{ status: "unknown" }` | The outcome is uncertain, including a partially applied patch. Tessar closes the old stream and records the uncertain result. |

```ts
import { createApplyPatch, type PatchRecoveryDecision } from "@tessar/workspace";

const decisions = new Map<string, PatchRecoveryDecision>();
const applyPatch = createApplyPatch({
  root,
  reconcilePatch: ({ toolExecutionId }) =>
    decisions.get(toolExecutionId) ?? { status: "unknown" },
});
```

An incomplete path list leaves recovery unknown. Normal tool calls record their
existing `toolExecutionId` as the recovery key. Older patch executions without
that key continue to recover as unknown if the outcome was interrupted.

## `edit_file`

`edit_file` accepts `{ path, edits }` for one existing file. Each `oldText` must match a unique span of the original text, and the spans must be disjoint. Use an empty `newText` to remove a span. Matching treats LF and CRLF alike and preserves the BOM and the original bytes outside the replacement spans. The input follows [Pi's edit tool](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/tools/edit.ts).

```json
{
  "path": "src/orders.ts",
  "edits": [{ "oldText": "status = 'pending'", "newText": "status = 'paid'" }]
}
```

Each file change is published atomically. File creation uses a hard link in the target directory. If an I/O failure occurs partway through a multi-file patch, the error includes the paths already written. Tools configured with the same workspace path share a write queue within a process. Coordinate access with any other writers.

The tools check the execution's abort signal immediately before each atomic
file publication. Files published earlier in the patch remain applied.

### Recover an interrupted edit

When the application restores a persisted Session and calls
`session.recover({ streamId })`, it can reconcile an unconfirmed `edit_file`
call through `tools.edit_file.reconcile` on `WorkspacePlugin` or
`reconcileEdit` on `createEditFile`. The callback receives the existing
`toolExecutionId`, a validated workspace-relative `path`, and the requested
`edits`. It returns one of these decisions.

| Decision | Meaning |
| --- | --- |
| `completed` | The application verified that the edit was applied. Tessar restores the result and continues the original stream. |
| `safeToRetry` | The application verified that the original edit can safely run again. Tessar retries with the original arguments and continues the stream. |
| `unknown` | Tessar cancels the stream and records that the edit may already have been applied. The next message can start a new stream on the same Thread. |

To continue the original stream, a CLI can ask the user to inspect the file before calling `recover()`. Store the confirmed decision by `toolExecutionId`.

```ts
import { WorkspacePlugin, type EditRecoveryDecision } from "@tessar/workspace";

const decisions = new Map<string, EditRecoveryDecision>();
const workspace = new WorkspacePlugin(root, {
  tools: {
    edit_file: {
      reconcile: ({ toolExecutionId }) => decisions.get(toolExecutionId) ?? "unknown",
    },
  },
});

// When the application verifies the interrupted edit:
decisions.set(toolExecutionId, "completed");
await session.recover({ streamId });
```

The application can also page through `thread.listToolExecutions({ status: "interrupted" })` and match the record's `streamId`. The original workspace must still be accessible when recovery runs. The callback runs when Tessar reconciles an interrupted edit. Regular edits reuse the existing checkpoint's idempotency key field. An unresolved edit remains `unknown` when the callback is omitted or the file can no longer be verified within the workspace.
