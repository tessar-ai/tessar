# Plugin Distribution Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. Preserve the
> existing worktree and native execution preference; no implementation subagents.

**Goal:** Pay TD-001 for Node/npm hosts and the deferred Controller lifecycle bug.
**Architecture:** Optional @tessar/plugins uses native Node loading and npm;
core continues to own execution and PluginHost registration/disposal.
**Tech:** Node >=24.14, existing TypeScript/Vitest/pnpm; no new runtime dependency.
**Spec:** [Plugin Distribution](../specs/2026-10-15-plugin-distribution-design.md).

## Constraints

- Keep Plugin {id,setup(tessar)}, .hook, and core boundaries unchanged.
- Preserve existing dirty files; no publish/push/Git permission bypass.
- Mutate only the configured plugin environment; no shell-built npm commands.
- npm JS packages, local erasable TS; no automatic runtime package installation.
- Support Node/npm distribution; report standalone executable support separately.

## Review focus

1. Package exports resolve from the managed `npm/` environment; custom paths
   resolve from the configured root, with local dependencies taking precedence.
2. SDK interception must preserve identity without changing unrelated imports.
3. Failed installs must not activate plugins; helper dependencies stay helpers.
4. Paths with spaces and Windows npm invocation cannot execute shell input.
5. Closing must remove module hooks after plugin resources have been disposed.

## Task 1: Lifecycle and native plugin loading

Files: packages/core/src/controller{,.test}.ts; packages/plugins/{package.json,
tsconfig.json,src/index.ts,src/index.test.ts}; root aliases/workspace lockfile.

Produces: PluginManager({directory,hostUrl?}), discover/load/dispose.

- [x] Reproduce initialize-after-dispose with a failing regression, fix shared
  lifecycle guards, and run Controller tests GREEN (4/4).
- [x] Add failing local/TS/package/identity/lazy/error/cleanup loader tests.
- [x] Implement discovery and scoped native resolver; validate default Plugin exports.
- [x] Run focused tests, typecheck and package build.

## Task 2: Native npm management

Files: packages/plugins/src/index.ts and focused tests.
Consumes Task1's configured directory; produces install/update/remove and manifest
activation consumed by discover/load. No second plugin registration lifecycle.

- [x] Test real offline local package installation with a helper dependency, update,
  removal, failed install and argument/path handling; observe RED.
- [x] Delegate to npm, preserve manifest fields and activate only successful packages.
- [x] Verify actual npm processes and loading installed packages, then full unit suite.

## Task 3: Installed host proof and documentation

Files: examples/cli/{package.json,src/main.ts}, tests/integration/plugin-distribution.test.ts,
README.md, docs/plugin-authoring.md, docs/architecture-notes.md and boundary checks.

- [x] Add failing packed-host subprocess tests loading a new root plugin after install.
- [x] Integrate optional discovery and plugin install/update/remove/list commands in demo.
- [x] Document use, SDK peer/TS rules, restart semantics and executable limitations.
- [x] Run frozen install/typecheck/build/unit/integration/boundaries/pack/diff checks.
- [x] Review the changes, fix reproduced defects, and update debt status with evidence.

## Result

Layout update, 2026-10-16: custom plugins remain auto-discovered from `plugins/`.
Package activation moves to `plugins.json` (`packages` array); npm's manifest,
lockfile and node_modules move under `npm/`. Install/update/remove/load keep the
same API. Tests cover config validation, preservation of config/manifest fields,
real install/update/remove, installed-host loading, host SDK identity and custom
ESM/CommonJS dependency resolution with distinct import/require exports. No
automatic move/delete of existing environments is performed.

All tasks completed. Typecheck/build, 113 unit tests and 10 integration tests
(123 total, four workers), package boundaries and diff checks pass on Windows.
Frozen install passed in the earlier verification; this layout update changes no
dependencies. Installed-host proof
uses actual tarballs and offline npm in a separate environment. No core runtime
dependency was added; @tessar/plugins uses Node built-ins and installed npm.

Fresh independent review found CommonJS SDK lookup, CLI relative paths and source
name validation defects; all were reproduced RED and fixed GREEN. The README
approval-command reference was corrected. No deferred minor remains from this review.
The Node/npm portion of TD-001 and the previous Controller lifecycle minor are
addressed. The user explicitly selected Node/npm CLI distribution; standalone
executable packaging is outside this completed scope. Live registry/Git and hosted
CI remain unverified.
Changes remain in the worktree under the existing Git permission restriction.
