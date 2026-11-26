import { createTool, type ReconcileResult } from "@tessar/core/tool";
import { z } from "zod";
import { invalidConfiguration, invalidPatch } from "./errors.js";
import { RECOVERY } from "./recovery.js";
import { FileWriteQueue } from "./workspace.js";

export const APPLY_PATCH = "apply_patch";
const PATCH_INSTRUCTIONS = "Supply a patch bounded by *** Begin Patch and *** End Patch. " +
  "Use *** Add File: <path> with + lines for new files, or *** Update File: <path> with @@ hunks and exact context, - and + lines. " +
  "Use relative paths and include enough context to locate each change uniquely.";

export type PatchRecoveryDecision =
  | { status: typeof RECOVERY.COMPLETED; paths: readonly string[] }
  | Exclude<ReconcileResult, { status: typeof RECOVERY.COMPLETED }>;

export interface ApplyPatchOptions {
  root: string;
  reconcilePatch?: (request: {
    readonly toolExecutionId: string;
    readonly patch: string;
  }) => PatchRecoveryDecision | Promise<PatchRecoveryDecision>;
}

export function createApplyPatch({ root, reconcilePatch }: ApplyPatchOptions) {
  if (reconcilePatch !== undefined && typeof reconcilePatch !== "function")
    invalidConfiguration("reconcilePatch must be a function");
  const writes = new FileWriteQueue(root);
  return createTool({
    name: APPLY_PATCH,
    description: "Create or edit workspace files. " + PATCH_INSTRUCTIONS,
    schema: z.object({ patch: z.string().min(1) }),
    async execute({ patch }, { signal }) {
      signal.throwIfAborted();
      if (!patch.isWellFormed()) invalidPatch("Patch must be UTF-8 text");
      const paths = await writes.run(signal, (root, native, token) => native.applyPatch(root, patch, token));
      return { paths };
    },
    recovery: {
      idempotencyKey: (_input, { toolExecutionId }) => toolExecutionId,
      async reconcile({ id, input: { patch } }) {
        if (!reconcilePatch || !patch.isWellFormed()) return { status: RECOVERY.UNKNOWN };
        const paths = await writes.run(undefined, (root, native) =>
          native.findPatchTargets(root, patch),
        ).catch(() => []);
        if (!paths.length) return { status: RECOVERY.UNKNOWN };
        const decision = await reconcilePatch({ toolExecutionId: id, patch });
        if (decision?.status === RECOVERY.SAFE_TO_RETRY) return { status: RECOVERY.SAFE_TO_RETRY };
        if (
          decision?.status === RECOVERY.COMPLETED &&
          Array.isArray(decision.paths) &&
          decision.paths.length === paths.length
        ) {
          const confirmed = new Set(decision.paths);
          if (paths.every((path) => confirmed.has(path)))
            return { status: RECOVERY.COMPLETED, result: { paths } };
        }
        return { status: RECOVERY.UNKNOWN };
      },
    },
  });
}
