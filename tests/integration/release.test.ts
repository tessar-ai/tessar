import { expect, it, vi, onTestFinished, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const script = pathToFileURL(resolve("scripts/release.mjs")).href;
const { checkRelease, verifyArchive, checkRegistry } = await import(script);
afterEach(() => vi.unstubAllGlobals());

function fixture(
  versions = { core: "0.1.4", opentelemetry: "0.1.0", plugins: "0.8.0" },
) {
  const root = mkdtempSync(join(tmpdir(), "tessar-release-test-"));
  onTestFinished(() => {
    const target = resolve(root);
    if (
      !target.startsWith(resolve(tmpdir()) + "\\") &&
      !target.startsWith(resolve(tmpdir()) + "/")
    )
      throw Error("Unsafe cleanup target");
    rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  for (const [name, version] of Object.entries(versions)) {
    const directory = join(root, "packages", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: "@tessar/" + name,
        version,
        type: "module",
        publishConfig: {
          access: "public",
          registry: "https://registry.npmjs.org/",
        },
        repository: { url: "git+https://github.com/tessar-ai/tessar.git" },
        exports: {
          ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
        },
      }),
    );
  }
  return root;
}
function manifest(root: string, name: string) {
  return JSON.parse(
    readFileSync(join(root, "packages", name, "package.json"), "utf8"),
  );
}
function patch(root: string, name: string, change: object) {
  writeFileSync(
    join(root, "packages", name, "package.json"),
    JSON.stringify({ ...manifest(root, name), ...change }),
  );
}
const files = [
  "package/package.json",
  "package/README.md",
  "package/dist/index.js",
  "package/dist/index.d.ts",
];

it.each([
  ["0.1.0", "latest"],
  ["0.2.0-beta.1", "next"],
])("selects only opentelemetry@%s and its npm channel", (version, tag) => {
  const root = fixture({
    core: "0.1.4",
    opentelemetry: version,
    plugins: "3.2.1",
  });
  expect(checkRelease({ root, ref: "opentelemetry@" + version })).toEqual({
    package: "@tessar/opentelemetry",
    shortName: "opentelemetry",
    directory: "packages/opentelemetry",
    version,
    tag,
    archive: `dist/release/tessar-opentelemetry-${version}.tgz`,
  });
});

it("discovers a new package by manifest name without a hardcoded package or folder list", () => {
  const root = fixture();
  const directory = join(root, "packages", "new-adapter");
  mkdirSync(directory);
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      ...manifest(root, "opentelemetry"),
      name: "@tessar/new-provider",
      version: "2.1.0",
    }),
  );
  expect(checkRelease({ root, ref: "new-provider@2.1.0" })).toMatchObject({
    package: "@tessar/new-provider",
    directory: "packages/new-adapter",
    version: "2.1.0",
  });
});

it("checks only the selected package's version and rejects private or unknown packages", () => {
  const root = fixture();
  expect(checkRelease({ root, ref: "core@0.1.4" }).version).toBe("0.1.4");
  expect(() => checkRelease({ root, ref: "core@0.1.0" })).toThrow(
    "@tessar/core version must match core@0.1.0",
  );
  expect(() => checkRelease({ root, ref: "missing@0.1.0" })).toThrow(
    "Expected one workspace package",
  );
  patch(root, "opentelemetry", { private: true });
  expect(() => checkRelease({ root, ref: "opentelemetry@0.1.0" })).toThrow(
    "must be publishable",
  );
});

it.each([
  "v0.1.0",
  "main",
  "opentelemetry@01.2.3",
  "opentelemetry@1.2.3-beta.01",
  "../opentelemetry@0.1.0",
  "opentelemetry@0.1.0\n",
  "opentelemetry@0.1.0\ntag=latest",
])("rejects invalid or legacy release tag %j", (ref) => {
  const root = fixture();
  expect(() => checkRelease({ root, ref })).toThrow("Expected a release tag");
});

it("validates packed dependencies against their own workspace versions, independent of the release version", () => {
  const root = fixture();
  patch(root, "opentelemetry", {
    dependencies: { "@tessar/core": "workspace:*" },
  });
  const plan = checkRelease({ root, ref: "opentelemetry@0.1.0" });
  const packed = {
    ...manifest(root, "opentelemetry"),
    dependencies: { "@tessar/core": "0.1.4" },
  };
  expect(verifyArchive(root, plan, packed, files)).toBe(packed);
  expect(() =>
    verifyArchive(
      root,
      plan,
      { ...packed, dependencies: { "@tessar/core": "0.1.0" } },
      files,
    ),
  ).toThrow("Incorrect dependencies entry");
  expect(() =>
    verifyArchive(
      root,
      plan,
      { ...packed, dependencies: { "@tessar/core": "workspace:*" } },
      files,
    ),
  ).toThrow("Unresolved workspace dependency");
});

it("preserves independently versioned workspace peer ranges", () => {
  const root = fixture();
  patch(root, "plugins", {
    peerDependencies: { "@tessar/core": "workspace:^" },
  });
  const plan = checkRelease({ root, ref: "plugins@0.8.0" });
  const packed = {
    ...manifest(root, "plugins"),
    peerDependencies: { "@tessar/core": "^0.1.4" },
  };
  expect(verifyArchive(root, plan, packed, files)).toBe(packed);
});

it("rejects wrong tarball identities, missing exports and private files", () => {
  const root = fixture(),
    plan = checkRelease({ root, ref: "opentelemetry@0.1.0" }),
    packed = manifest(root, "opentelemetry");
  expect(() =>
    verifyArchive(root, plan, { ...packed, name: "@tessar/core" }, files),
  ).toThrow();
  expect(() =>
    verifyArchive(
      root,
      plan,
      packed,
      files.filter((file) => !file.endsWith("index.js")),
    ),
  ).toThrow("Missing export");
  expect(() =>
    verifyArchive(root, plan, packed, [...files, "package/.env.production"]),
  ).toThrow("Unexpected private/test files");
});

it("accepts a published compatible dependency even when it differs from the release and local version", async () => {
  const root = fixture(),
    plan = checkRelease({ root, ref: "opentelemetry@0.1.0" });
  const fetch = vi.fn(async (url: string) =>
    url.endsWith(encodeURIComponent("@tessar/opentelemetry"))
      ? new Response("{}", { status: 404 })
      : Response.json({ versions: { "0.1.5": {} } }),
  );
  vi.stubGlobal("fetch", fetch);
  await checkRegistry(plan, {
    dependencies: { "@tessar/core": "^0.1.4", "external-lib": "*" },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("blocks republishing an existing version before checking dependencies", async () => {
  const root = fixture(),
    plan = checkRelease({ root, ref: "opentelemetry@0.1.0" });
  const fetch = vi.fn(async () => Response.json({ versions: { "0.1.0": {} } }));
  vi.stubGlobal("fetch", fetch);
  await expect(checkRegistry(plan, {})).rejects.toThrow("already published");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([null, { "0.2.0": {} }])(
  "blocks unpublished or incompatible internal dependencies: %j",
  async (versions) => {
    const root = fixture(),
      plan = checkRelease({ root, ref: "opentelemetry@0.1.0" });
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith(encodeURIComponent("@tessar/opentelemetry")) || !versions
        ? new Response("{}", { status: 404 })
        : Response.json({ versions }),
    );
    await expect(
      checkRegistry(plan, { peerDependencies: { "@tessar/core": "^0.1.4" } }),
    ).rejects.toThrow("Publish a compatible @tessar/core@^0.1.4");
  },
);

it("reports registry failures instead of treating them as unpublished versions", async () => {
  const root = fixture(),
    plan = checkRelease({ root, ref: "opentelemetry@0.1.0" });
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 403 }));
  await expect(checkRegistry(plan, {})).rejects.toThrow("Registry HTTP 403");
});
