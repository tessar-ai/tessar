import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { createTool } from "@tessar/core/tool";
import { z } from "zod";
import { invalidPatch } from "./errors.js";
import { PATCH_INSTRUCTIONS, parsePatch, updateText } from "./patch.js";
import { readTextFile } from "./text.js";
import { Workspace, pathKey, publishWrites, regularFileMode, resolveTarget, type Write } from "./workspace.js";

export const APPLY_PATCH = "apply_patch";

export function createApplyPatch({ root }: { root: string }) {
  const workspace = new Workspace(root);
  return createTool({
    name: APPLY_PATCH,
    description: "Create or edit workspace files. " + PATCH_INSTRUCTIONS,
    schema: z.object({ patch: z.string().min(1) }),
    execute({ patch }, { signal }) {
      signal.throwIfAborted();
      const changes = parsePatch(patch);
      return workspace.run(signal, async (root) => {
        const writes: Write[] = [];
        const targets = new Set<string>();
        for (const change of changes) {
          signal.throwIfAborted();
          const { path, target, current } = await resolveTarget(root, change.path);
          const key = pathKey(current && !current.isSymbolicLink() ? await realpath(target) : target);
          if (targets.has(key)) invalidPatch(`Patch contains the same file twice: ${path}`);
          targets.add(key);
          if ("text" in change) {
            if (current) invalidPatch(`File already exists: ${path}`);
            writes.push({ path, target, text: change.text });
          } else {
            const mode = regularFileMode(current, path);
            const text = await readTextFile(target, signal);
            if (text === undefined) invalidPatch(`Cannot edit a non-text file: ${path}`);
            writes.push({ path, target, text: updateText(text, change.hunks, path), mode });
          }
        }
        for (const { path, target } of writes) {
          for (let parent = dirname(target); pathKey(parent) !== pathKey(root); parent = dirname(parent)) {
            if (targets.has(pathKey(parent))) invalidPatch(`Patch targets a file and its child: ${path}`);
          }
        }
        return { paths: await publishWrites(writes, signal) };
      });
    },
  });
}
