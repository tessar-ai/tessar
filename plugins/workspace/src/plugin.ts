import type { Plugin, PluginContext } from "@tessar/core";
import { Tool } from "@tessar/core/tool";
import { APPLY_PATCH, createApplyPatch, type ApplyPatchOptions } from "./apply-patch.js";
import { EDIT_FILE, createEditFile, type EditFileOptions } from "./edit-file.js";
import { EXEC_COMMAND, createExecCommand, type ExecCommandOptions } from "./exec-command.js";
import { invalidConfiguration } from "./errors.js";
import { READ_FILE, createReadFile } from "./read-file.js";
import { resolveWorkspaceRoot } from "./workspace.js";

const TOOL_NAMES = new Set<string>([APPLY_PATCH, EDIT_FILE, READ_FILE, EXEC_COMMAND]);
type ToolOptions<Options extends object = object> = false | (Options & { name?: string });

export interface WorkspaceOptions {
  tools?: {
    [APPLY_PATCH]?: ToolOptions<{ reconcile?: ApplyPatchOptions["reconcilePatch"] }>;
    [EDIT_FILE]?: ToolOptions<{ reconcile?: EditFileOptions["reconcileEdit"] }>;
    [READ_FILE]?: ToolOptions;
    [EXEC_COMMAND]?: ToolOptions<Omit<ExecCommandOptions, "root">>;
  };
}

function configureTool<Options extends { name?: string }>(
  options: false | Options | undefined,
  create: (options?: Options) => Tool,
): Tool | undefined {
  if (options === false) return;
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options)))
    invalidConfiguration("Workspace tool options must be an object or false");
  const tool = create(options);
  const name = options?.name ?? tool.name;
  return name === tool.name ? tool : new Tool({ ...tool, name });
}

export class WorkspacePlugin implements Plugin {
  readonly id = "workspace";
  readonly configurationId: string;
  readonly #tools: readonly Tool[];

  constructor(root: string, { tools }: WorkspaceOptions = {}) {
    const workspaceRoot = resolveWorkspaceRoot(root);
    if (tools !== undefined) {
      if (tools === null || typeof tools !== "object" || Array.isArray(tools))
        invalidConfiguration("Workspace tools must be configured with an object");
      for (const name of Object.keys(tools))
        if (!TOOL_NAMES.has(name))
          invalidConfiguration(`Unknown workspace tool: ${name}`);
    }
    const writers = [
      configureTool(tools?.[APPLY_PATCH], (options) => createApplyPatch({ root: workspaceRoot, reconcilePatch: options?.reconcile })),
      configureTool(tools?.[EDIT_FILE], (options) => createEditFile({ root: workspaceRoot, reconcileEdit: options?.reconcile })),
    ].filter((tool) => tool !== undefined);
    this.#tools = [
      ...writers,
      configureTool(tools?.[READ_FILE], () => createReadFile({ root: workspaceRoot })),
      configureTool(tools?.[EXEC_COMMAND], (options) => createExecCommand({ ...options, root: workspaceRoot })),
    ].filter((tool) => tool !== undefined);
    // Preserve the configuration identity stored by existing write-tool checkpoints.
    this.configurationId = JSON.stringify({
      root: workspaceRoot,
      tools: writers.map(({ name }) => name).toSorted(),
    });
  }

  setup(tessar: PluginContext): void {
    for (const tool of this.#tools) tessar.tools.register(tool);
  }
}
