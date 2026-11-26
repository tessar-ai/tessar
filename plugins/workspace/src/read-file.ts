import { createTool } from "@tessar/core/tool";
import { z } from "zod";
import { invalidPath } from "./errors.js";
import { runFileOperation } from "./native.js";
import { resolveWorkspaceRoot } from "./workspace.js";

export const READ_FILE = "read_file";
const FIRST_LINE = 1;
const MAX_PAGE_LINES = 2_000;

export function createReadFile({ root }: { root: string }) {
  const workspaceRoot = resolveWorkspaceRoot(root);
  return createTool({
    name: READ_FILE,
    description:
      "Read complete lines from a UTF-8 text file in the workspace. " +
      "If nextLine is a number and you need more of the file, call again with the same path and set startLine to nextLine. " +
      "If nextLine is null, you have reached the end of the file.",
    schema: z.object({
      path: z.string().min(1).describe("Workspace-relative file path"),
      startLine: z.int().positive().optional().describe("First line to read, counted from 1"),
      limit: z.int().positive().optional().describe(`Maximum lines to read, defaults to and is capped at ${MAX_PAGE_LINES}`),
    }),
    async execute({ path, startLine = FIRST_LINE, limit = MAX_PAGE_LINES }, { signal }) {
      signal.throwIfAborted();
      if (!path.isWellFormed()) invalidPath(`Expected a workspace-relative path: ${path}`);
      const page = await runFileOperation(signal, (native, token) =>
        native.readFile(workspaceRoot, path, startLine, Math.min(limit, MAX_PAGE_LINES), token),
      );
      return { text: page.text, nextLine: page.nextLine ?? null };
    },
  });
}
