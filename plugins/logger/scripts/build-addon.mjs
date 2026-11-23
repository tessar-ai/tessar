import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const platforms = {
  win32: ["pc-windows-msvc", "tessar_logger.dll"],
  linux: ["unknown-linux-gnu", "libtessar_logger.so"],
  darwin: ["apple-darwin", "libtessar_logger.dylib"],
};
const architectures = { x64: "x86_64", arm64: "aarch64" };
const system = platforms[process.platform];
const architecture = architectures[process.arch];
if (!system || !architecture) throw new Error(`Unsupported logger platform ${process.platform}-${process.arch}`);

const root = resolve(import.meta.dirname, "..");
const bin = join(root, "dist", "bin");
const addon = join(bin, `${process.platform}-${process.arch}.node`);

const [family, library] = system;
const target = `${architecture}-${family}`;
const output = join(root, "target");
execFileSync("cargo", ["build", "--release", "--locked", "--target", target, "--target-dir", output], {
  cwd: root,
  stdio: "inherit",
});
mkdirSync(bin, { recursive: true });
copyFileSync(join(output, target, "release", library), addon);
