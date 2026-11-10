# Contributing to Tessar

This page is for contributors and maintainers working on the SDK itself. To use
Tessar in an application, start with the [developer guides](examples/guide/README.md).

## Local development

Requires Node.js >=24.22.1 and pnpm 11.5.3.

Database plugins live in `plugins/database/<backend>` and keep the package names
`@tessar/libsql`, `@tessar/postgresql` and `@tessar/mongodb`.
Authentication integrations live in `integrations/auth/<provider>` and publish as
`@tessar/auth-<provider>`. Workspace discovery, builds, tests and releases include
these packages alongside `packages/*`; integrations depend on the public server
contract rather than adding provider dependencies to the server.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test --maxWorkers 4
pnpm test:integration --maxWorkers 4
pnpm check:boundaries
```

The private applications in `tests/fixtures/apps/cli` and
`tests/fixtures/apps/headless` are consumers used by integration tests. Keep their
sources in the repository; build outputs and `node_modules` remain ignored. They are not
included in npm releases.

For real database tests, set `TESSAR_TEST_POSTGRES_URL` and
`TESSAR_TEST_MONGODB_URL` in the environment or ignored `.env.storage`, then run:

```sh
pnpm test:storage --maxWorkers 4
```

These tests use generated schemas/databases and skip when their URLs are absent.
MongoDB needs a replica set or sharded deployment supporting transactions.

## Storage adapter structure

Keep equivalent responsibilities in the same place across libSQL, PostgreSQL and
MongoDB. `database.ts` declares an explicit `Database` interface and `openDatabase()`
for the borrowed connection; `schema.ts` initializes state storage when the backend
factory calls it. `transaction.ts` owns native commit, rollback and connection/session
cleanup, shared by state and vector storage. State-specific error mapping remains
separate so vector operations preserve native errors. Vector-only use must not
initialize state tables or collections. Native fields and synchronous/asynchronous
operations may differ; libSQL also enables foreign keys for connection integrity.

## Public API changes

[API-REVIEW.md](API-REVIEW.md) records the implemented public surface for comparison
with agreed behavior; code and generated declarations do not override design decisions.
[developer guides](examples/guide/README.md) show supported application flows.
Dated documents under `docs/superpowers/` preserve design history. They do not
authorize restoring APIs removed or superseded by later decisions.

Before changing a public API:

- Record the agreed behavior and its acceptance criteria before implementation.
  State its purpose and the agreed Agent/Controller/Session/plugin boundary. New
  core APIs must supply generic primitives rather than prescribe one plugin's policy.
- Trace both producer and consumer. Check package exports, built declarations,
  hooks, persistence and call sites; an exported type alone does not prove usability.
- Add or update a runnable consumer using public package imports for the changed
  flow. Harness tests cover runtime internals and do not replace this check.
- Update the API reference and affected guides in the same change. Mark conflicting
  historical sections superseded, and report commands actually verified in the PR.

If implementation contradicts an agreed design, report the discrepancy before
changing the design. Do not silently redefine the contract to match existing code.

## Releases

To build and package all public SDK packages locally:

```sh
pnpm build:release
```

Each package's existing `prepack` builds its source and includes its license.
The command writes versioned `.tgz` archives to `dist/release/`, resolves
workspace dependencies for distribution, and excludes the private fixture apps.
It does not publish to npm. Regular `pnpm build` keeps output in each package's
own `dist/` directory.

Public packages are versioned and released independently. Update only the
package being released and any dependency that also needs a new version. The
private workspace root's version is not used for publishing. Commit the changes
to `release`, then create a tag using the package's unscoped name and version:

```sh
git push origin release
git tag opentelemetry@0.1.0
git push origin opentelemetry@0.1.0
```

Use the next unpublished version, rather than copying the example version.
Pushes to `release` and pull requests run CI. Wait for the `release` branch's CI
to succeed before pushing a package tag for that commit. Package tags trigger
`.github/workflows/release.yml`, which checks the latest push CI run for the
exact tagged commit on `release` instead of running the test suite again. A
missing, pending or unsuccessful CI run blocks publication; after CI succeeds,
re-run the failed release workflow without moving the tag.

The release workflow discovers the selected package under
`packages/*/package.json`, `plugins/database/*/package.json` and
`integrations/auth/*/package.json`, validates its version, builds the workspace, and
packs/publishes only that package. Adding a package does not require editing a
publish list. Legacy `v*` tags no longer trigger publication.
Stable tags use npm `latest`; prereleases such as `plugins@0.2.0-beta.1` use `next`.
The CLI package `@tessar/cli` remains in `packages/cli` and uses tags such as
`cli@0.1.0`, producing `tessar-cli-0.1.0.tgz`. Its executable remains `tessar`.

Extensions that use the application's Core runtime declare `@tessar/core` as a
required `peerDependency: "workspace:^"`, with `devDependency: "workspace:*"` for
workspace builds/tests. This includes OpenAI, storage backends, OpenTelemetry,
RAG, TypeSafe and server. The plugins package keeps its optional Core peer.
Use one compatible application Core version; do not bypass incompatible peer
requirements with force/override settings. Peer declarations do not make these
packages independent of Core or guarantee one copy for an incompatible graph.

The globally installed CLI keeps Core as a normal `workspace:^` dependency,
alongside Hono and its Node adapter. The browser client has no runtime/peer
dependencies; its runtime and declaration files must not import backend packages.
Database drivers, backend vector RAG peers and Express integration peers stay
optional and are installed by the developer when selected. Core requires Zod;
Vitest is an optional peer only for `@tessar/core/testing/storage-conformance`.
Do not move test frameworks into regular runtime dependencies.

Versions of other packages do not need to match. For example, OpenTelemetry `0.1.0`
can use Core `0.1.5` through a compatible peer range. pnpm rewrites `workspace:*` to the dependency's own
version when packing; `workspace:^` becomes a compatible range. The workflow
checks the actual archive and rejects unresolved or incorrectly rewritten
dependencies. It also checks npm for an already published target version and
compatible published internal dependencies before attempting publication.

Publish changed dependencies first and wait for their release to succeed before
tagging dependents. For the current release, publish `core@0.1.6` first, then
RAG and server before database vector plugins and auth integrations respectively.
Existing extensions use `plugins@0.1.6`, `openai@0.1.5`, `opentelemetry@0.1.2`,
`libsql@0.1.4`, `postgresql@0.1.5` and `mongodb@0.1.5`.
Packed extension Core peers use the compatible `^0.1.6` range.
When releasing multiple versions of the same package, finish the earlier
release first so the `latest` npm tag cannot race backwards.

Each package needs npm Trusted Publishing configured for GitHub owner
`tessar-ai`, repository `tessar`, workflow `release.yml`, no environment and
permission to run `npm publish`. The workflow uses OIDC rather than `NPM_TOKEN`.
See [npm's setup instructions](https://docs.npmjs.com/trusted-publishers/).

New packages need an initial authenticated publish before configuring their
package settings. OpenTelemetry `0.1.0` has already been published manually and
Trusted Publishing configured. Publish its next version through Actions:

```sh
git tag opentelemetry@0.1.1
git push origin opentelemetry@0.1.1
```

First commit/push the version change to `release` and wait for that exact commit's
CI to pass, as for other packages. Do not push `opentelemetry@0.1.0` to trigger
another publish of the version that was already published manually.

To inspect a release locally without publishing, use PowerShell:

```powershell
$env:RELEASE_TAG = 'opentelemetry@0.1.0'
$plan = node scripts/release.mjs check | ConvertFrom-Json
pnpm build
pnpm --filter $plan.package pack --pack-destination "$PWD/dist/release"
node scripts/release.mjs verify
node scripts/release.mjs registry
```

Each tag publishes one artifact, named with that package and version. A failed
publish can be retried after checking npm; an existing version fails preflight
rather than being silently replaced or republished. Re-running an old tag uses
its original commit, including its workflow. Never move a published release tag.
