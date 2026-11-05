# tessar

Create Tessar projects and project-local TypeScript files. Requires Node.js 24.22.1 or newer.

CLI validation and scaffolding errors use `TessarCLIError`, extending core's
`TessarError`. Core is installed as a runtime dependency of the CLI. Native
filesystem and library failures retain their original errors; contextual project
validation errors keep the original failure as `cause`. Errors still print to
stderr with a nonzero exit status.

```sh
npm install -g tessar
tessar new my-agent
```

`new` asks whether to include a Controller, then optionally a Session and a storage
backend. Choose Memory, libSQL, PostgreSQL or MongoDB. Session and backend choices
are shown only when Controller is enabled. Review the configuration and confirm
before the CLI creates any files. Answer `y`/`n` and choose the backend by number;
type `cancel`, press Ctrl+C or decline confirmation to leave the target untouched.

After creation:

```sh
cd my-agent
npm install
```

Without a global installation, use `npx tessar new my-agent` or
`npx tessar g <kind> <name>`.

Copy `.env.example` to `.env`, set `OPENAI_API_KEY` and `OPENAI_MODEL`, then run:

```sh
npm start -- "Hello!"
npm run typecheck
```

The starter compiles with TypeScript and runs one prompt using OpenAIChat through
the selected Agent/Controller/Session setup. Session projects create a conversation
thread. Backend projects include connection configuration, the storage plugin and
cleanup for their owned connection. Only the selected backend and driver are added
to the generated manifest. Memory uses the core default without extra dependencies.

Creating a project does not install dependencies, call a model or connect to a
database. Configure the selected backend environment variables in `.env` before
running the project; MongoDB must support transactions. Generated code creates
the driver connection and closes it after disposing the Controller.

Piped answers work for scripts too. EOF cancels rather than creating a default
project. For example, choose Agent only and confirm:

```sh
printf 'n\ny\n' | tessar new my-agent
```

Run generators from your project root:

```sh
tessar generate agent researcher
tessar g tool search
tessar g controller main
tessar g session chat
tessar g plugin logging
tessar g plugin guard --type hook --event tool.before
tessar g plugin context --type hook --event context.prepare
```

| Kind | Destination |
| --- | --- |
| agent | `src/agents/<name>.ts` |
| tool | `src/tools/<name>.ts` |
| controller | `src/controllers/<name>.ts` |
| session | `src/sessions/<name>.ts` |
| plugin | `src/plugins/<name>.ts` |

Names use lowercase kebab-case. Existing files are never overwritten. Generators
create files; import and connect the resulting exports yourself. Existing projects
need `@tessar/core`; tool templates also need `zod`.

Plugin `--type` supports `basic` (default), `tool`, `hook`, `provider`, `storage`
and `capability`. These are templates for the same SDK Plugin contract. Tool,
provider, storage and capability templates accept values through constructors and
register them in setup. Resources created by your plugin should use `tessar.defer()`
for cleanup. Connections passed in remain your responsibility.

Hook templates require `--event` with a built-in event identifier. Transformation
hooks initially return their payload; other hooks initially do nothing. Implement
your behavior in the generated handler. Unsupported events are rejected.

Controller factories accept `{ agent, plugins? }`; call `initialize()` before use
and `dispose()` when finished. Agent factories accept a model selection.

Session factories accept an initialized Controller and optional `SessionOptions`:

```ts
import { createChatSession } from "./sessions/chat.js";

const session = await createChatSession(controller, {
  scope: { userId: "user-42" },
});
await session.thread.create({ title: "Conversation" });
// Subscribe and submit follow-ups through the Session API.
// When finished: await session.close();
```

The factory uses `controller.createSession(options)`. Without an explicit `id`,
each call gets a fresh ID. Pass `threadId` to create a thread immediately, or
create/select one through the returned Session before submitting follow-ups.

Use `tessar --help` or `tessar --version`. This package provides scaffolding;
runtime hosting, watch mode and an interactive chat interface are outside its scope.

## Maintaining templates

Editable source templates live in `templates/`: a project directory and separate
agent, tool, controller, session and plugin templates. `.tpl` files contain ordinary output
text with `{{name}}`, `{{className}}`, `{{variableName}}`, `{{event}}` or dependency
version placeholders. Missing placeholder values fail before writing output.

`_gitignore.tpl` and `_env.example.tpl` become `.gitignore` and `.env.example`.
The starter reuses the agent generator for its assistant. Hook transformations
have a separate template so handler code stays in template files.

The published package includes `templates/` alongside `dist/`. Templates are
resolved relative to the installed module, independently of the working directory.
Tests compile generated files against the public SDK and exercise every generator
after installing a CLI tarball into an isolated prefix. Project composition lives
separately from the prompt flow in `ProjectWizard`, so new choices can be added
alongside their own templates as the SDK grows.
