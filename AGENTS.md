# Repository Guidelines

## Project Structure & Module Organization

Tessar is a TypeScript ESM monorepo for building CLI agents and application integrations. Keep its core minimal; additional capabilities belong in plugins.

- `packages/core/src/`: Agent, Controller, Session, loop, hooks, messages and state contracts.
- `packages/{openai,plugins,opentelemetry,sqlite,postgresql,mongodb}/src/`: provider adapters, plugin utilities, tracing and storage backends.
- `packages/*/test/`: package tests; `tests/integration/`: cross-package and process tests.
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

## Testing Guidelines

Name Vitest tests `*.test.ts` and place them beside other tests in the relevant test directory. Add focused regression coverage for behavioral fixes. No numeric coverage threshold is configured. Database tests skip when their URLs are absent; skipped tests do not verify a backend.

## Commit & Pull Request Guidelines

Follow existing Conventional Commit patterns: `feat(plugin): ...`, `fix(ci): ...`, or `chore(release): ...`. Keep commits focused. PRs should explain the problem, resulting behavior, API or persistence changes and commands actually verified; link related issues when applicable. Update developer guides for public API changes.

## Security & Configuration

Keep credentials in ignored environment files. Storage tests read `TESSAR_TEST_POSTGRES_URL` and `TESSAR_TEST_MONGODB_URL`, optionally from `.env.storage`; MongoDB requires transaction support through a replica set or sharded deployment. Never commit credentials, database files or generated output. Public packages have independent versions and package-specific release tags; see `CONTRIBUTING.md` for publication steps.
