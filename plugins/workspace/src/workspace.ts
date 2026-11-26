import { resolve } from "node:path";
import { invalidConfiguration } from "./errors.js";
import { runFileOperation, type Cancellation, type FileResult, type NativeFileSystem } from "./native.js";

const pendingWrites = new Map<string, Promise<void>>();

export function resolveWorkspaceRoot(root: string): string {
  if (typeof root !== "string" || !root.trim())
    invalidConfiguration("A workspace root is required");
  return resolve(root);
}

export class FileWriteQueue {
  readonly #root: string;
  readonly #key: string;

  constructor(root: string) {
    this.#root = resolveWorkspaceRoot(root);
    this.#key = process.platform === "win32" ? this.#root.toLowerCase() : this.#root;
  }

  run(
    signal: AbortSignal | undefined,
    operation: (root: string, binding: NativeFileSystem, token: Cancellation) => Promise<FileResult>,
  ): Promise<string[]> {
    signal?.throwIfAborted();
    const work = (pendingWrites.get(this.#key) ?? Promise.resolve()).then(async () =>
      (await runFileOperation(signal, (binding, token) => operation(this.#root, binding, token))).paths,
    );
    const settled = work.then(() => { }, () => { });
    pendingWrites.set(this.#key, settled);
    return work.finally(() => {
      if (pendingWrites.get(this.#key) === settled) pendingWrites.delete(this.#key);
    });
  }
}
