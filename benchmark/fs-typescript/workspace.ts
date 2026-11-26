import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { TessarFsError, invalidConfiguration, invalidPath } from "./errors.js";

const PATCH_WRITE_FAILED = "PatchWriteFailed";
const MISSING_PATH = "ENOENT";
const WINDOWS_RESERVED_CHARACTER = /[<>"|?*\u0000-\u001f]|[. ]$/u;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])$/iu;
const pendingWrites = new Map<string, Promise<void>>();

export type Write = { path: string; target: string; text: string; mode?: number };

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function workspacePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized.isWellFormed() || normalized.includes(":") || normalized.includes("\0") || normalized.split("/").some((part) =>
    part === "" || part === "." || part === ".." ||
    (process.platform === "win32" && (WINDOWS_RESERVED_CHARACTER.test(part) ||
      WINDOWS_DEVICE_NAME.test(part.split(".", 1)[0]!.trimEnd()))),
  )) invalidPath(`Expected a workspace-relative path: ${path}`);
  return normalized;
}

async function inspect(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== MISSING_PATH) throw error;
    return undefined;
  }
}

async function resolveParent(root: string, path: string): Promise<string> {
  const parent = await inspect(path);
  if (!parent) return join(await resolveParent(root, dirname(path)), basename(path));
  const location = await realpath(path);
  if (!inside(root, location)) invalidPath(`Path is outside the workspace: ${relative(root, path)}`);
  if (!(await stat(location)).isDirectory()) invalidPath(`Expected a parent directory: ${relative(root, path)}`);
  return location;
}

async function writeAtomic(write: Write, signal: AbortSignal, paths: string[]): Promise<void> {
  const parent = dirname(write.target);
  if (write.mode === undefined) await mkdir(parent, { recursive: true });
  const temp = join(parent, `.tessar-patch-${randomUUID()}`);
  const file = await open(temp, "wx", write.mode);
  let published = false;
  try {
    try {
      await file.writeFile(write.text, { encoding: "utf8", signal });
      if (write.mode !== undefined) await file.chmod(write.mode);
    } finally {
      await file.close();
    }
    signal.throwIfAborted();
    if (write.mode === undefined) await link(temp, write.target);
    else await rename(temp, write.target);
    published = true;
    paths.push(write.path);
  } finally {
    if (!published || write.mode === undefined) await unlink(temp);
  }
}

export function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export async function resolveTarget(root: string, requested: string) {
  const path = workspacePath(requested);
  const name = resolve(root, path);
  const parent = await resolveParent(root, dirname(name));
  const target = join(parent, basename(name));
  return { path, target, current: await inspect(target) };
}

export function regularFileMode(current: Stats | undefined, path: string): number {
  if (!current?.isFile()) invalidPath(`Expected an existing regular file: ${path}`);
  return current.mode & 0o777;
}

export async function publishWrites(writes: readonly Write[], signal: AbortSignal): Promise<string[]> {
  const paths: string[] = [];
  try {
    for (const write of writes) {
      signal.throwIfAborted();
      await writeAtomic(write, signal, paths);
    }
  } catch (error) {
    if (!paths.length) throw error;
    throw new TessarFsError(PATCH_WRITE_FAILED, `Patch stopped after writing: ${paths.join(", ")}`, {
      source: "tool",
      details: { paths },
      cause: error,
    });
  }
  return paths;
}

export class Workspace {
  readonly #root: string;

  constructor(root: string) {
    if (typeof root !== "string" || !root.trim())
      invalidConfiguration("A workspace root is required");
    this.#root = resolve(root);
  }

  run<T>(signal: AbortSignal | undefined, operation: (root: string) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const key = pathKey(this.#root);
    const write = (pendingWrites.get(key) ?? Promise.resolve()).then(async () => {
      signal?.throwIfAborted();
      const root = await realpath(this.#root);
      if (!(await stat(root)).isDirectory()) invalidPath("The workspace root must be a directory");
      return operation(root);
    });
    const settled = write.then(() => { }, () => { });
    pendingWrites.set(key, settled);
    return write.finally(() => {
      if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
    });
  }
}
