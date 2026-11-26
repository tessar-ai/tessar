import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { TessarWorkspaceError, invalidConfiguration } from "./errors.js";

export interface Cancellation {
  cancel(): void;
}

interface Failure {
  code: string;
  message: string;
  paths?: string[];
  causeCode?: string;
  causeMessage?: string;
}

type FailedOperation = { error: Failure };
export type FileResult = { paths: string[]; error?: undefined } | FailedOperation;
type ReadResult = { text: string; nextLine?: number; error?: undefined } | FailedOperation;

export interface NativeFileSystem {
  Cancellation: new () => Cancellation;
  applyPatch(root: string, patch: string, token: Cancellation): Promise<FileResult>;
  editFile(root: string, path: string, edits: readonly { oldText: string; newText: string }[], token: Cancellation): Promise<FileResult>;
  findEditTarget(root: string, path: string): Promise<FileResult>;
  findPatchTargets(root: string, patch: string): Promise<FileResult>;
  readFile(root: string, path: string, startLine: number, limit: number, token: Cancellation): Promise<ReadResult>;
}

const FS_ERRORS = new Set(["InvalidPath", "InvalidPatch", "InvalidEdit", "InvalidRead", "PatchWriteFailed"]);
const CANCELLED = "Cancelled";
const load = createRequire(import.meta.url);
let binding: NativeFileSystem | undefined;

export function nativeFileSystem(): NativeFileSystem {
  if (binding) return binding;
  const target = `${process.platform}-${process.arch}`;
  try {
    binding = load(fileURLToPath(new URL(`../dist/native/${target}.node`, import.meta.url))) as NativeFileSystem;
    return binding;
  } catch (cause) {
    invalidConfiguration(`Cannot load @tessar/workspace native addon for ${target}`, cause);
  }
}

function fileError(error: Failure, signal: AbortSignal | undefined): unknown {
  if (error.code === CANCELLED && signal?.aborted) return signal.reason;
  if (!FS_ERRORS.has(error.code)) return Object.assign(new Error(error.message), { code: error.code });
  return new TessarWorkspaceError(error.code, error.message, {
    source: "tool",
    ...(error.paths && { details: { paths: error.paths } }),
    ...(error.causeCode && {
      cause: fileError({ code: error.causeCode, message: error.causeMessage ?? error.message }, signal),
    }),
  });
}

export async function runFileOperation<Result extends { error?: undefined }>(
  signal: AbortSignal | undefined,
  operation: (binding: NativeFileSystem, token: Cancellation) => Promise<Result | FailedOperation>,
): Promise<Result> {
  signal?.throwIfAborted();
  const native = nativeFileSystem();
  const token = new native.Cancellation();
  const cancel = () => token.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await operation(native, token);
    if (result.error) throw fileError(result.error, signal);
    return result;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
