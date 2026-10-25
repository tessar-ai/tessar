import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import semver from "semver";

const registry = "https://registry.npmjs.org/";
const repository = "git+https://github.com/tessar-ai/tessar.git";
const dependencyKinds = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
];

function workspace(root) {
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(root, "packages", entry.name, "package.json")),
    )
    .map((entry) => ({
      directory: `packages/${entry.name}`,
      manifest: JSON.parse(
        readFileSync(
          join(root, "packages", entry.name, "package.json"),
          "utf8",
        ),
      ),
    }));
}

export function checkRelease({
  root = process.cwd(),
  ref = process.env.RELEASE_TAG ?? "",
} = {}) {
  const match = /^([a-z0-9][a-z0-9._-]*)@(.+)$/.exec(ref);
  assert.ok(
    match && semver.valid(match[2]) === match[2],
    "Expected a release tag such as opentelemetry@0.1.0 or core@0.2.0-beta.1",
  );
  const [, shortName, version] = match;
  const name = `@tessar/${shortName}`;
  const matches = workspace(root).filter(
    (entry) => entry.manifest.name === name,
  );
  assert.equal(
    matches.length,
    1,
    `Expected one workspace package named ${name}`,
  );
  const { directory, manifest } = matches[0];
  assert.match(
    directory,
    /^packages\/[a-z0-9][a-z0-9._-]*$/,
    "Unsupported package directory",
  );
  assert.equal(manifest.version, version, `${name} version must match ${ref}`);
  assert.ok(!manifest.private, `${name} must be publishable`);
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.publishConfig?.registry, registry);
  assert.equal(manifest.repository?.url, repository);
  const tag = semver.prerelease(version) ? "next" : "latest";
  if (manifest.publishConfig.tag !== undefined)
    assert.equal(
      manifest.publishConfig.tag,
      tag,
      `${name} has a conflicting publish tag`,
    );
  return {
    package: name,
    shortName,
    directory,
    version,
    tag,
    archive: `dist/release/tessar-${shortName}-${version}.tgz`,
  };
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (!value) return [];
  return Object.values(value).flatMap(exportTargets);
}

export function verifyArchive(root, plan, packed, files) {
  const packages = workspace(root);
  const source = packages.find(
    (entry) => entry.manifest.name === plan.package,
  ).manifest;
  assert.equal(packed.name, plan.package);
  assert.equal(packed.version, plan.version);
  assert.ok(
    !JSON.stringify(packed).includes("workspace:"),
    "Unresolved workspace dependency in " + plan.package,
  );
  assert.equal(packed.publishConfig?.access, "public");
  assert.equal(packed.publishConfig?.registry, registry);
  assert.equal(packed.repository?.url, source.repository.url);
  assert.ok(
    files.includes("package/README.md"),
    "Missing README in " + plan.package,
  );
  assert.ok(
    !files.some((file) =>
      /\/(?:test|tests|node_modules)\/|\.test\.|\/(?:\.env(?:\.[^/]*)?|\.npmrc)$/.test(
        file,
      ),
    ),
    "Unexpected private/test files in " + plan.package,
  );
  for (const target of exportTargets(packed.exports))
    assert.ok(
      files.includes("package/" + target.replace(/^\.\//, "")),
      "Missing export " + target,
    );

  // pnpm resolves each workspace dependency against that package's own version.
  for (const kind of dependencyKinds) {
    for (const [name, specifier] of Object.entries(source[kind] ?? {})) {
      let expected = specifier;
      if (specifier.startsWith("workspace:")) {
        const dependency = packages.find(
          (entry) => entry.manifest.name === name,
        )?.manifest;
        assert.ok(dependency, `Missing workspace dependency ${name}`);
        const range = specifier.slice("workspace:".length);
        expected =
          range === "*"
            ? dependency.version
            : range === "^" || range === "~"
              ? range + dependency.version
              : range;
        assert.ok(
          semver.validRange(expected),
          `Unsupported workspace dependency ${name}: ${specifier}`,
        );
        assert.ok(
          semver.satisfies(dependency.version, expected),
          `Workspace version does not satisfy ${name}: ${specifier}`,
        );
      }
      assert.equal(
        packed[kind]?.[name],
        expected,
        `Incorrect ${kind} entry for ${name} in ${plan.package}`,
      );
    }
  }
  return packed;
}

export function verifyRelease(root, plan) {
  const archive = resolve(root, plan.archive);
  const tar = (args) =>
    execFileSync("tar", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const packed = JSON.parse(tar(["-xOf", archive, "package/package.json"]));
  const files = tar(["-tzf", archive]).trim().split(/\r?\n/);
  return verifyArchive(root, plan, packed, files);
}

export async function checkRegistry(plan, packed) {
  const metadata = new Map();
  const read = async (name) => {
    if (metadata.has(name)) return metadata.get(name);
    const response = await fetch(registry + encodeURIComponent(name), {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(15000),
    });
    assert.ok(
      response.ok || response.status === 404,
      `Registry HTTP ${response.status} for ${name}`,
    );
    const value = response.status === 404 ? null : await response.json();
    metadata.set(name, value);
    return value;
  };
  const target = await read(plan.package);
  assert.ok(
    !target?.versions?.[plan.version],
    `${plan.package}@${plan.version} is already published`,
  );
  const dependencies = new Set();
  for (const kind of dependencyKinds.slice(0, 3)) {
    for (const [name, range] of Object.entries(packed[kind] ?? {})) {
      if (!name.startsWith("@tessar/")) continue;
      const key = `${name}@${range}`;
      if (dependencies.has(key)) continue;
      dependencies.add(key);
      assert.ok(semver.validRange(range), `Invalid registry dependency ${key}`);
      const available = await read(name);
      assert.ok(
        semver.maxSatisfying(Object.keys(available?.versions ?? {}), range),
        `Publish a compatible ${key} before ${plan.package}@${plan.version}`,
      );
    }
  }
}

// This CLI only validates and reads npm metadata; publishing stays in Actions.
if (import.meta.main) {
  const mode = process.argv[2] ?? "check";
  assert.ok(
    ["check", "verify", "registry"].includes(mode),
    "Usage: node scripts/release.mjs [check|verify|registry]",
  );
  const plan = checkRelease();
  if (mode !== "check") {
    const packed = verifyRelease(process.cwd(), plan);
    if (mode === "registry") await checkRegistry(plan, packed);
  }
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(plan)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  console.log(JSON.stringify(plan));
}
