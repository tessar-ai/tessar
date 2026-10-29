# Plugin Distribution (TD-001)

Status: implemented and locally verified for Node/npm hosts. The user requested paying the recorded technical debt.
This extends the minimal-core design; existing plugin and runtime APIs stay intact.

## Outcome

A Node CLI installed outside the current project can discover and load plugins
from that project without rebuilding itself. A local plugin using only the host
SDK requires no npm installation. A package plugin and its own dependencies are
installed using npm. Core remains independent of Node filesystem/module/process APIs.
Also fix Controller.initialize returning a fulfilled promise after disposal starts.

## Approach

Add the optional Node package `@tessar/plugins`, exporting PluginManager.
Putting loading into core would add platform policy to the minimal runtime;
implementing a bundler/package manager would duplicate existing platform tools.
Use Node 24.14+ module hooks/import/type stripping and the installed npm CLI.
The user selected Node/npm CLI distribution. Users install a compatible Node/npm
runtime and install the consuming CLI through npm. TD-001 is addressed within this
selected target. Standalone executable packaging is outside this scope and is not
implied by a successful Node package test.

The SDK remains an npm library whichever distribution a consuming CLI chooses.
Node/npm delivery needs a compatible Node installation and keeps ordinary module
loading and release workflows. A single binary embeds a fixed runtime and avoids
that installation step, but adds OS/CPU artifacts and runtime-specific external
module loading. Plugin dependency installation still needs an explicit package
manager strategy. A third option bundles a portable Node runtime alongside JS:
end users need not install Node, while filesystem-based loading is retained.
This archive still needs per-platform delivery and runtime updates.

The current loader is Node-specific. Bun's compatibility documentation lists
registerHooks as missing; a Bun executable requires a Bun loader adapter. Node SEA
also needs a real packaging test because embedded scripts have different loading
rules. These alternatives are comparison context, not remaining deliverables for
the selected Node/npm scope.

```ts
const manager = new PluginManager({
  directory: resolve(process.cwd(), ".tessar"),
  hostUrl: import.meta.url,
});
const plugins = await manager.load();
// Pass plugins to Controller, then initialize Controller normally.
// Dispose Controller before manager.dispose(), including after startup failure.
```

The host chooses the directory and when loading occurs. Merely importing this
package creates no files, installs no packages and starts no processes.

## Discovery and loading

`discover(): Promise<string[]>` returns sorted local entry files from `plugins/`
under the configured directory followed by package names in its `plugins.json`
`packages` array, for example `{ "packages": ["some-plugin"] }.
Custom files and folders do not require configuration entries. The configured
directory is chosen by the consuming host; `.tessar` is the demo default.
Supported entries: .mjs/.js/.cjs/.mts/.ts/.cts;
.d.ts/.d.mts/.d.cts are excluded. Plugin folders use one index entry with those
extensions. Missing optional directories/config mean no plugins; malformed data
and missing explicitly configured entries fail with their source identified.

`load(sources?: readonly string[]): Promise<Plugin[]>` imports the discovered or
explicit sources in order. Explicit relative paths resolve against the configured
directory; package specifiers resolve from its `npm/` subdirectory using import conditions.
Each module must default-export one Plugin object with a nonempty id and setup
function. Reject duplicate IDs and invalid exports before returning the list.
Setup and disposal remain the existing PluginHost's responsibility. Module-level
side effects cannot be rolled back by a loader; loading is an explicit host action.

Use one scoped Node registerHooks resolver per manager, released by dispose().
Track the imported graph; imports of @tessar/core and its public subpaths in
that graph resolve using hostUrl, so plugins use the host's actual SDK classes.
Other dependencies use normal resolution relative to the importing plugin.
Custom plugins can also resolve missing bare package imports from the managed
`npm/` environment, preserving import/require export conditions.
SDK resolution uses the host's ESM import conditions even for a CommonJS require,
so SDK identity does not depend on a plugin's own package lookup paths.
Outside modules retain normal resolution. Keep hooks registered through runtime
shutdown because a plugin can import lazily. No transpiler, source rewriting,
global SDK object, custom apiVersion, evaluator or duplicate agent loop.

Local TS uses native erasable-type support; no tsconfig path aliases, TSX or enum
transform is promised. npm packages publish runnable JS. Package authors declare
the host SDK as a compatible peer dependency; loading resolves that peer to the
host, not a bundled private copy. Missing exports fail normally; the loader is not
a compatibility shim. Persisted plugin contracts retain their existing versions.

## Package operations

`install(source, {name?}?)`, `update(name?)`, and `remove(name)` operate only in the
configured directory's `npm/` subdirectory, using npm with argument arrays and no
shell interpolation. Installed code lives in `npm/node_modules/`; the npm manifest
and lockfile are `npm/package.json` and `npm/package-lock.json`. Create its private
package.json only when an install requires it. Preserve other config and manifest
fields. Install uses save-exact; update follows npm's saved dependency
constraints. To choose a newer version outside those constraints, install that
explicit version. Git/tarball sources may provide name explicitly; local package
directories can supply it from package.json. Never infer a Git package name from
its repository basename. Record plugin names only after npm succeeds and the
requested package is a direct dependency. Validate the source's actual package name before
activation; an existing dependency is not proof that it matches the source. For
Git/tarball metadata use npm pack --dry-run --ignore-scripts --json. Helpers are not
automatically treated as plugins. Remove uninstalls through npm, then removes its
name from `plugins.json`'s `packages` array. Do not hand-delete dependency trees
or custom plugin files. The previous root `package.json`/`tessar.plugins`
layout is replaced; existing environments are not moved or deleted automatically.

Serialize a manager's mutations; npm owns dependency resolution, lockfiles and
lifecycle scripts. npm failures propagate; no atomicity across npm and manifest
writes is claimed. Do not mutate one managed directory from multiple processes.
Installation executes the chosen package manager's ordinary behavior. Plugin code
is trusted application code, not a sandbox. Loading never installs missing imports.

Runtime attach/detach remains available for already loaded objects. Updating a
module on disk requires restarting its process because Node caches ESM modules;
this feature does not promise hot reload or unload arbitrary JavaScript state.
Manager API paths resolve from its directory; CLI source paths resolve from cwd.
Use one compatible host SDK per process. Node's cache cannot rebind already evaluated
shared modules to different SDK versions for multiple hosts; use separate processes
when different SDK versions must coexist.

## Acceptance

- Local JS and erasable TS load from an unrelated project without a local SDK.
- ESM import-only package exports resolve from the plugin environment.
- SDK identity and lazy imports use the host; unrelated imports are unaffected.
- Invalid exports/duplicate IDs/config/module failures report the source.
- Real offline npm install/update/remove with local package dependencies works.
- A packed, installed CLI loads a newly added project plugin without rebuilding.
- Module hooks are released at shutdown; no startup install/network side effect.
- Controller initialization and admission reject once disposal starts.
- Full types/build/unit/integration/boundary checks remain green.

Sources: [Node TypeScript](https://nodejs.org/docs/latest-v24.x/api/typescript.html),
[Node 24.14 module hooks](https://nodejs.org/download/release/v24.14.0/docs/api/module.html),
[npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/),
[Node SEA](https://nodejs.org/download/release/v24.14.0/docs/api/single-executable-applications.html),
[Bun compatibility](https://bun.com/docs/runtime/nodejs-compat).

Verification updated 2026-10-16: strict typecheck, six package/example builds,
113 unit tests and 10 integration tests (123 total, four workers), package
boundaries and diff checks passed on Windows. Frozen install passed in the earlier
distribution verification; this layout update adds no dependency. A minimal CLI
was actually packed and installed offline before adding
a new project plugin; the built demo CLI was also exercised. Native npm tests cover
local packages/helper dependencies, tarballs, updates/removal and invalid names.
Independent review's three Important findings were reproduced and fixed; the
README wording finding was corrected. No deferred minor remains from that review.
Live registry/Git transport, standalone binaries and hosted CI were not tested.
