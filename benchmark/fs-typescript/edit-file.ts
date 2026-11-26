import { createTool, type ReconcileResult } from "@tessar/core/tool";
import { z } from "zod";
import { TessarFsError, invalidConfiguration } from "./errors.js";
import { UTF8_BOM, readTextFile } from "./text.js";
import { Workspace, publishWrites, regularFileMode, resolveTarget } from "./workspace.js";

export const EDIT_FILE = "edit_file";
const INVALID_EDIT = "InvalidEdit";
const RECOVERY = {
  COMPLETED: "completed",
  SAFE_TO_RETRY: "safeToRetry",
  UNKNOWN: "unknown",
} as const;
const LINE_ENDING = /\r\n|[\r\n]/u;
const CR_LINE_ENDING = /\r\n?/gu;
const replacementSchema = z.object({
  oldText: z.string().min(1).describe("Unique text from the original file"),
  newText: z.string().describe("Replacement text, or an empty string to remove the old text"),
});
type Replacement = z.infer<typeof replacementSchema>;

export type EditRecoveryDecision = ReconcileResult["status"];

export interface EditFileOptions {
  root: string;
  reconcileEdit?: (request: {
    readonly toolExecutionId: string;
    readonly path: string;
    readonly edits: readonly Readonly<Replacement>[];
  }) => EditRecoveryDecision | Promise<EditRecoveryDecision>;
}

function invalidEdit(message: string): never {
  throw new TessarFsError(INVALID_EDIT, message, { source: "tool" });
}

function editResult(path: string): string {
  return `Edited ${path}`;
}

function replaceText(original: string, edits: readonly Replacement[], path: string): string {
  const bom = original.startsWith(UTF8_BOM) ? UTF8_BOM : "";
  const source = original.slice(bom.length);
  const removedOffsets: number[] = [];
  const normalized = source.replace(CR_LINE_ENDING, (ending, offset: number) => {
    if (ending.length === 2) removedOffsets.push(offset - removedOffsets.length);
    return "\n";
  });
  const matches = edits.map(({ oldText, newText }, index) => {
    if (!oldText || !oldText.isWellFormed() || !newText.isWellFormed() || oldText.includes("\0") || newText.includes("\0"))
      invalidEdit(`Edit ${index + 1} must contain valid text: ${path}`);
    const before = oldText.replace(CR_LINE_ENDING, "\n");
    const after = newText.replace(CR_LINE_ENDING, "\n");
    const start = normalized.indexOf(before);
    if (start === -1) invalidEdit(`Edit ${index + 1} text was not found: ${path}`);
    if (normalized.indexOf(before, start + 1) !== -1) invalidEdit(`Edit ${index + 1} text is ambiguous: ${path}`);
    return { start, end: start + before.length, before, after };
  }).sort((a, b) => a.start - b.start);

  const parts = [bom];
  const defaultEnding = source.match(LINE_ENDING)?.[0] ?? "\n";
  let removed = 0;
  let previousEnd = 0;
  let tail = 0;
  function originalOffset(offset: number): number {
    while (removed < removedOffsets.length && removedOffsets[removed]! < offset) removed++;
    return offset + removed;
  }

  for (const { start, end, before, after } of matches) {
    if (start < previousEnd) invalidEdit(`Edits overlap: ${path}`);
    const originalStart = originalOffset(start);
    const originalEnd = originalOffset(end);
    const originalText = source.slice(originalStart, originalEnd);
    const ending = originalText.match(LINE_ENDING)?.[0] ?? defaultEnding;
    parts.push(source.slice(tail, originalStart), before === after ? originalText : after.replaceAll("\n", ending));
    previousEnd = end;
    tail = originalEnd;
  }
  parts.push(source.slice(tail));
  const result = parts.join("");
  if (result === original) invalidEdit(`No changes made: ${path}`);
  return result;
}

export function createEditFile({ root, reconcileEdit }: EditFileOptions) {
  if (reconcileEdit !== undefined && typeof reconcileEdit !== "function")
    invalidConfiguration("reconcileEdit must be a function");
  const workspace = new Workspace(root);
  return createTool({
    name: EDIT_FILE,
    description: "Edit an existing workspace file. Each oldText must match a unique, non-overlapping span of the original file.",
    schema: z.object({
      path: z.string().min(1).describe("Workspace-relative file path"),
      edits: z.array(replacementSchema).min(1).describe("Replacements evaluated against the original file"),
    }),
    execute({ path, edits }, { signal }) {
      return workspace.run(signal, async (root) => {
        const file = await resolveTarget(root, path);
        const mode = regularFileMode(file.current, file.path);
        const original = await readTextFile(file.target, signal);
        if (original === undefined) invalidEdit(`Cannot edit a non-text file: ${file.path}`);
        const text = replaceText(original, edits, file.path);
        await publishWrites([{ path: file.path, target: file.target, text, mode }], signal);
        return editResult(file.path);
      });
    },
    recovery: {
      idempotencyKey: (_input, { toolExecutionId }) => toolExecutionId,
      async reconcile({ id, input: { path, edits } }) {
        if (!reconcileEdit) return { status: RECOVERY.UNKNOWN };
        const file = await workspace.run(undefined, (root) => resolveTarget(root, path)).catch(() => undefined);
        if (!file?.current?.isFile()) return { status: RECOVERY.UNKNOWN };
        const status = await reconcileEdit({ toolExecutionId: id, path: file.path, edits });
        if (status === RECOVERY.COMPLETED) return { status, result: editResult(file.path) };
        return { status: status === RECOVERY.SAFE_TO_RETRY ? status : RECOVERY.UNKNOWN };
      },
    },
  });
}
