# Repository Guidelines

## Project Structure & Module Organization

Tessar is a TypeScript ESM monorepo for building CLI agents and application integrations. Keep its core minimal; additional capabilities belong in plugins.

- `packages/core/src/`: Agent, Controller, Session, loop, hooks, messages and state contracts.
- `packages/{openai,plugins,opentelemetry}/src/`: provider adapters, plugin utilities and tracing.
- `plugins/database/{libsql,postgresql,mongodb}/`: database backend plugins; npm package names remain `@tessar/<backend>`.
- `packages/*/test/`: package tests; `tests/integration/`: cross-package and process tests.
- `integrations/auth/<provider>/`: independent authentication packages published as `@tessar/auth-<provider>`; tests live in each package's `test/` directory.
- `tests/fixtures/apps/{cli,headless}/`: private applications exercised by integration tests.
- `examples/guide/`: public developer guides. Build output goes into ignored `dist/` directories.

## Build, Test, and Development Commands

Use Node.js >=24.22.1 and pnpm 11.5.3 from the repository root.

- `pnpm install --frozen-lockfile`: install the workspace using its committed lockfile.
- `pnpm typecheck`: check source and test types without emitting files.
- `pnpm build`: compile all workspace packages and fixture applications.
- `pnpm test --maxWorkers 4`: run package tests with Vitest.
- `pnpm test:integration --maxWorkers 4`: run integration tests after building.
- `pnpm check:boundaries`: enforce core dependency boundaries and detect runtime import cycles.
- `pnpm test:storage --maxWorkers 4`: exercise configured PostgreSQL and MongoDB backends.

## Coding Style & Naming Conventions

Use strict TypeScript, explicit type imports and `.js` extensions in relative imports. Prefer two-space indentation, double quotes and semicolons; preserve surrounding formatting. No repository formatter or lint command is configured. Use PascalCase for classes, camelCase for functions and kebab-case filenames. Keep provider and storage implementations outside core. Fixture applications should use public package exports.

### Consistent Implementation Patterns

- Code with the same responsibility across packages must follow the same structure, naming, type declarations and lifecycle boundaries. Read the equivalent implementations before adding or changing one; do not introduce another pattern for the same job.
- Storage `database.ts` modules use an explicit `Database` interface and an `openDatabase()` function. They receive developer-owned connections; schema initialization belongs in `schema.ts` and is invoked by the backend factory.
- Native transaction lifecycle belongs in each backend's `transaction.ts` and is reused by state and vector storage. Keep state-specific error mapping separate from native transaction errors.
- Use platform differences to justify different fields, operations or asynchronous I/O, not unrelated differences in organization. Do not force SQL and document databases into a shared abstraction.
- When an existing pattern must change, check and update equivalent callers, tests and documentation together. Record any necessary backend exception and its reason.
- Preserve explicit runtime ownership: registering `agents` on Tessar must not create Controllers or Sessions. A Controller owns one Agent; delegation/subagents remain developer/plugin behavior. Server and client layers expose the registered runtime APIs without inventing orchestration.

### Constants

- Use named constants for configuration defaults and behavioral limits, even when used once: hostname, port, timeout, retry count, batch size, concurrency and buffer/page limits. Defaults must have one clear place to change.
- Extract repeated values that represent the same meaning. Equal literals with different meanings do not need a shared constant.
- Use constants for typo-prone runtime identifiers and protocol values: error codes, event names, execution phases, provider/protocol IDs, HTTP status codes, route parameter names, MIME types, storage/index names and fixed configuration filenames. Reuse an existing constant before introducing another.
- Keep constants local to the file when only that file needs them. Share within the package only when multiple files need the same value; do not create a large constants module by default.
- Do not share constants across packages or add a cross-package dependency just to reuse them. Each package owns its values.
- Use descriptive UPPER_SNAKE_CASE names, with `as const` objects for related values when useful. Keep `index.ts` limited to intentional public API exports; internal constants are not public API by default.
- Do not extract every string or number. Single-use prose, ordinary object keys, type literals and obvious structural values such as zero or one can stay inline unless they encode a configurable default, behavioral limit or protocol meaning above.
- Before finishing a change, check new and touched literals against these rules without waiting for a separate audit or reminder. Update affected examples and documentation when a default or protocol value changes; tests should still independently assert the expected behavior.

## Testing Guidelines

Name Vitest tests `*.test.ts` and place them beside other tests in the relevant test directory. Add focused regression coverage for behavioral fixes. No numeric coverage threshold is configured. Database tests skip when their URLs are absent; skipped tests do not verify a backend.

## Commit & Pull Request Guidelines

Follow existing Conventional Commit patterns: `feat(plugin): ...`, `fix(ci): ...`, or `chore(release): ...`. Keep commits focused. PRs should explain the problem, resulting behavior, API or persistence changes and commands actually verified; link related issues when applicable. Update developer guides for public API changes.

## Security & Configuration

Keep credentials in ignored environment files. Storage tests read `TESSAR_TEST_POSTGRES_URL` and `TESSAR_TEST_MONGODB_URL`, optionally from `.env.storage`; MongoDB requires transaction support through a replica set or sharded deployment. Never commit credentials, database files or generated output. Public packages have independent versions and package-specific release tags; see `CONTRIBUTING.md` for publication steps.
