# Workspace, Sandbox and Code Mode

Tessar applications can adopt each capability independently. Workspace selects
where tools work. A sandbox supplies an isolated execution environment. Code Mode
runs scripts that compose tools exposed by the application.

| Capability | Responsibilities | Composition |
| --- | --- | --- |
| `@tessar/workspace` | Register tools for reading, editing and running commands in a project. | The default environment is a local directory. A future adapter can use a sandbox or another environment selected by the application. |
| Sandbox | Provide an execution environment and enforce its filesystem, network and process permissions. | Applications can use a sandbox directly or supply it to Workspace. The application or provider owns its lifecycle. |
| Code Mode | Discover allowed tools, expose their signatures to the model and execute model-authored scripts in isolation. | The script runner exposes selected tools through Tessar's execution path. These can come from the application, MCP or Workspace. |

A script that calls `create_event()` uses the calendar tool without a project
workspace. A script that calls `read_file()` gets the result from the Workspace
tool through the same tool boundary. The script runner only needs access to the
exposed functions. The Workspace tool owns access to the project files.

## Local Workspace

Rename `@tessar/fs` to `@tessar/workspace` and expose `WorkspacePlugin`,
`WorkspaceOptions` and `TessarWorkspaceError`. Keep the existing constructor
and per-tool configuration.

```ts
import { WorkspacePlugin } from "@tessar/workspace";

const workspace = new WorkspacePlugin("./project", {
  tools: { apply_patch: false },
});
```

The filesystem tools are `read_file`, `edit_file` and `apply_patch`. Their
arguments, results, error codes and cancellation behavior stay the same. Keep
the standalone factories and reconciliation callbacks. The plugin ID is
`workspace`. Keep the tool names and configuration identity used to recover
checkpoints created by `fs`. The native crate is `tessar_workspace`. Use
`workspace@<version>` for release tags and retain the current native artifact
matrix.

## Command execution

`exec_command` accepts a `command` string and a required human-readable `reason`.
The command runs in the project root used by the file tools. The reason is
available to policy and approval hooks. The tool uses the shell default of the
machine running Tessar, `%ComSpec%` (with `cmd.exe` as fallback) on Windows and
`/bin/sh` on macOS and Linux. Applications can configure `shell`, `timeoutMs`
and `maxOutputBytes` when creating the tool.

Defaults are 30 seconds and a tail of 2,000 lines or 50 KiB of output across
both streams, whichever limit is reached first.

The result contains `stdout`, `stderr`, `exitCode` and `truncated`. A nonzero
exit code is a command result. A timeout rejects with `CommandTimeout`. A tool
abort rejects with the signal's reason. Cancellation targets the foreground
process tree.
Set `tools.exec_command` to `false` to disable it on `WorkspacePlugin`.
`createExecCommand()` also works independently with `Agent.tools`.

A host process runs with the application's operating-system permissions. Use
`tool.before` to apply application policy and request approval. Future background
jobs and scheduling are independent of Workspace. A Workspace tool can use a
background job capability when the application provides one.

For a future remote environment, file tools and commands must see the same
project instance. Resolve paths relative to the root inside the selected
environment. The first concrete provider will determine how project data arrives
and how changes can be retrieved. A checkout, an uploaded snapshot and a shared
mount have different persistence and synchronization semantics.

## Script execution

Code Mode needs an isolated script runner and a way to invoke the allowed tools
through the existing Tessar execution path. Each invocation must preserve input
validation, policy and traceability. Tools requiring human approval can stay in
the direct tool path until script suspension and resumption have a defined
contract. `tool.before` governs the invocation. The chosen execution environment
enforces what the running code can access.

Tool discovery should provide the signatures relevant to the task. A script can
combine results and return a concise summary. Measure model round trips and
context size on dependent tool calls and compare them with the existing tool
loop. Backend selection and the Code Mode API are separate decisions from the
local Workspace rename.

## References

- [Mastra filesystem and mounts](https://mastra.ai/docs/sandbox/filesystem)
- [Mastra sandboxes](https://mastra.ai/docs/sandbox/overview)
- [Strands Box](https://strandsagents.com/docs/user-guide/box/how-box-works/)
- [Strands Shell](https://strandsagents.com/docs/user-guide/shell/how-it-works/)
- [Mastra Code Mode](https://mastra.ai/docs/agents/code-mode)
- [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/)
