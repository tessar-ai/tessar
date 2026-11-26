import { spawnSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const targets = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};
const libraries = {
  darwin: "libtessar_workspace.dylib",
  linux: "libtessar_workspace.so",
  win32: "tessar_workspace.dll",
};
const platform = `${process.platform}-${process.arch}`;
const target = targets[platform];
if (!target) throw new Error(`Unsupported @tessar/workspace build platform: ${platform}`);

const native = fileURLToPath(new URL("../native/", import.meta.url));
const targetDir = join(native, "target");
const result = spawnSync("cargo", [
  "build", "--locked", "--release", "--target", target, "--target-dir", targetDir,
], { cwd: native, stdio: "inherit", windowsHide: true });
if (result.error) throw new Error("Building @tessar/workspace from source requires Cargo", { cause: result.error });
if (result.status !== 0) process.exit(result.status ?? 1);

const dist = fileURLToPath(new URL("../dist/native/", import.meta.url));
await mkdir(dist, { recursive: true });
await copyFile(join(targetDir, target, "release", libraries[process.platform]), join(dist, `${platform}.node`));
