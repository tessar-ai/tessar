# CLI scaffolding

Install `@tessar/cli` globally to create a project:

```sh
npm install -g @tessar/cli
tessar new my-agent
```

Choose whether to include a Controller. With Controller enabled, choose whether to
include Session and select Memory, libSQL, PostgreSQL or MongoDB storage. Confirm
the summary before any files are created. Type `cancel`, press Ctrl+C or decline
confirmation to stop without creating a project.

Then install the generated project's dependencies:

```sh
cd my-agent
npm install
```

Copy `.env.example` to `.env` and choose your API key and model. Run
`npm start -- "Your prompt"` for one model request through your selected setup,
or `npm run typecheck`. Backend projects include their own connection setup and
cleanup; set the additional backend variables shown in `.env.example`. Creating
the project does not install dependencies or connect to the database.

Generate files from the project root:

```sh
tessar g agent researcher
tessar g tool search
tessar g controller main
tessar g session chat
tessar g plugin guard --type hook --event tool.before
```

`g` aliases `generate`. Files go into `src/agents`, `src/tools`, `src/controllers`, `src/sessions`
and `src/plugins`. Import them explicitly; generators do not register them or
rewrite existing files. See the [CLI reference](../../packages/cli/README.md)
for plugin templates and lifecycle responsibilities.

The generated Session factory receives an initialized Controller and optional
`SessionOptions`. It creates a Session through `controller.createSession()`;
create/select a thread before submitting follow-ups. See [Sessions](sessions.md).
