import { createTool, type ReconcileResult } from "@tessar/core/tool";
import { z } from "zod";
import { invalidConfiguration, invalidPath } from "./errors.js";
import { RECOVERY } from "./recovery.js";
import { FileWriteQueue } from "./workspace.js";

export const EDIT_FILE = "edit_file";
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

function editResult(path: string): string {
  return `Edited ${path}`;
}

export function createEditFile({ root, reconcileEdit }: EditFileOptions) {
  if (reconcileEdit !== undefined && typeof reconcileEdit !== "function")
    invalidConfiguration("reconcileEdit must be a function");
  const writes = new FileWriteQueue(root);
  return createTool({
    name: EDIT_FILE,
    description: "Edit an existing workspace file. Each oldText must match a unique, non-overlapping span of the original file.",
    schema: z.object({
      path: z.string().min(1).describe("Workspace-relative file path"),
      edits: z.array(replacementSchema).min(1).describe("Replacements evaluated against the original file"),
    }),
    async execute({ path, edits }, { signal }) {
      signal.throwIfAborted();
      if (!path.isWellFormed()) invalidPath(`Expected a workspace-relative path: ${path}`);
      const [edited] = await writes.run(signal, (root, native, token) => native.editFile(root, path, edits, token));
      return editResult(edited!);
    },
    recovery: {
      idempotencyKey: (_input, { toolExecutionId }) => toolExecutionId,
      async reconcile({ id, input: { path, edits } }) {
        if (!reconcileEdit || !path.isWellFormed()) return { status: RECOVERY.UNKNOWN };
        const paths = await writes.run(undefined, (root, native) => native.findEditTarget(root, path)).catch(() => []);
        const [existing] = paths;
        if (!existing) return { status: RECOVERY.UNKNOWN };
        const status = await reconcileEdit({ toolExecutionId: id, path: existing, edits });
        if (status === RECOVERY.COMPLETED) return { status, result: editResult(existing) };
        return { status: status === RECOVERY.SAFE_TO_RETRY ? status : RECOVERY.UNKNOWN };
      },
    },
  });
}
