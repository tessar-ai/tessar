# Contributing to Tessar

This page is for contributors and maintainers working on the SDK itself. To use
Tessar in an application, start with the [developer guides](examples/guide/README.md).

## Local development

Requires Node.js >=24.22.1 and pnpm 11.5.3.

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
`packages/*/package.json`, validates its version, builds the workspace, and
packs/publishes only that package. Adding a package does not require editing a
publish list. Legacy `v*` tags no longer trigger publication.
Stable tags use npm `latest`; prereleases such as `plugins@0.2.0-beta.1` use `next`.

Versions of other packages do not need to match. For example, OpenTelemetry `0.1.0`
can depend on Core `0.1.4`. pnpm rewrites `workspace:*` to the dependency's own
version when packing; `workspace:^` becomes a compatible range. The workflow
checks the actual archive and rejects unresolved or incorrectly rewritten
dependencies. It also checks npm for an already published target version and
compatible published internal dependencies before attempting publication.

Publish changed dependencies first and wait for their release to succeed before
tagging dependents. For the current release, publish `core@0.1.5` first, then
`plugins@0.1.5`, `openai@0.1.4`, `sqlite@0.1.4`, `postgresql@0.1.4` and
`mongodb@0.1.4`. Packed workspace dependencies use the new Core version.
When releasing multiple versions of the same package, finish the earlier
release first so the `latest` npm tag cannot race backwards.

Each package needs npm Trusted Publishing configured for GitHub owner
`tessar-ai`, repository `tessar`, workflow `release.yml`, no environment and
permission to run `npm publish`. The workflow uses OIDC rather than `NPM_TOKEN`.
See [npm's setup instructions](https://docs.npmjs.com/trusted-publishers/).

New packages need an initial authenticated publish before configuring their
package settings. OpenTelemetry's first release is published manually after
Core succeeds:

```sh
pnpm build:release
npm publish ./dist/release/tessar-opentelemetry-0.1.0.tgz --access public --tag latest
```

Then configure Trusted Publishing on npm for `@tessar/opentelemetry`. Its next
version can use the workflow. Do not push `opentelemetry@0.1.0` to trigger another
publish of the version that was just published manually.

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
