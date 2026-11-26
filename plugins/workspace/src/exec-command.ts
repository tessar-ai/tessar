import { execFile, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTool } from "@tessar/core/tool";
import { z } from "zod";
import { CommandOutput } from "./command-output.js";
import { invalidConfiguration, TessarWorkspaceError } from "./errors.js";
import { resolveWorkspaceRoot } from "./workspace.js";

export const EXEC_COMMAND = "exec_command";
const INVALID_COMMAND = "InvalidCommand";
const COMMAND_TIMEOUT = "CommandTimeout";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const STOP_TIMEOUT_MS = 2_000;
const WINDOWS_SYSTEM_ROOT = "C:\\Windows";
const FORCE_KILL = "SIGKILL";
const NO_SUCH_PROCESS = "ESRCH";
const WINDOWS = process.platform === "win32";
const runFile = promisify(execFile);

export interface ExecCommandOptions {
  root: string;
  shell?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
};

async function stopCommand(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (!WINDOWS) {
    try {
      process.kill(-child.pid, FORCE_KILL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== NO_SUCH_PROCESS) throw error;
    }
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const taskkill = join(process.env.SystemRoot ?? WINDOWS_SYSTEM_ROOT, "System32", "taskkill.exe");
  try {
    await runFile(taskkill, ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      timeout: STOP_TIMEOUT_MS,
    });
  } catch (error) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(FORCE_KILL);
    throw error;
  }
}

export function createExecCommand({
  root,
  shell,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
}: ExecCommandOptions) {
  const cwd = resolveWorkspaceRoot(root);
  if (shell !== undefined && (typeof shell !== "string" || !shell.trim() || shell.includes("\0")))
    invalidConfiguration("shell must be a shell executable name or path");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)
    invalidConfiguration(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)
    invalidConfiguration("maxOutputBytes must be a positive safe integer");

  return createTool({
    name: EXEC_COMMAND,
    description: "Run a shell command in the workspace and wait for it to exit. Returns stdout, stderr and the exit code. Keeps the end of long output.",
    schema: z.object({
      command: z.string().min(1).describe("Shell command to run from the workspace root"),
      reason: z.string().trim().min(1).describe("Briefly explain why this command is needed"),
    }),
    async execute({ command, reason }, { signal }) {
      signal.throwIfAborted();
      if (typeof command !== "string" || !command.trim() || command.includes("\0"))
        throw new TessarWorkspaceError(INVALID_COMMAND, "A shell command without NUL bytes is required", { source: "tool" });
      if (typeof reason !== "string" || !reason.trim())
        throw new TessarWorkspaceError(INVALID_COMMAND, "A reason for running the command is required", { source: "tool" });

      const child = spawn(command, {
        cwd,
        shell: shell ?? true,
        detached: !WINDOWS,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return new Promise<CommandResult>((resolve, reject) => {
        const output = new CommandOutput(maxOutputBytes);
        let stopping = false;
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        };
        const rejectAndClose = (error: unknown) => {
          child.stdout.destroy();
          child.stderr.destroy();
          reject(error);
        };
        const stop = (error: unknown) => {
          if (stopping) return;
          stopping = true;
          cleanup();
          void stopCommand(child).then(() => rejectAndClose(error), rejectAndClose);
        };
        const abort = () => stop(signal.reason);
        const timer = setTimeout(() => stop(new TessarWorkspaceError(
          COMMAND_TIMEOUT, `Command exceeded ${timeoutMs} ms`, { source: "tool" },
        )), timeoutMs);
        signal.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (chunk: Buffer) => output.add("stdout", chunk));
        child.stderr.on("data", (chunk: Buffer) => output.add("stderr", chunk));
        child.stdout.once("error", stop);
        child.stderr.once("error", stop);
        child.once("error", stop);
        child.once("close", (exitCode) => {
          if (stopping) return;
          cleanup();
          resolve({ ...output.finish(), exitCode });
        });
      });
    },
  });
}
