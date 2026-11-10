import { tool as toolHooks, type Plugin, type PluginContext } from "@tessar/core";

const WRITE_TOOL_NAME = "write";

export class BlockWritePlugin implements Plugin {
  readonly id = "block-write";

  setup(tessar: PluginContext): void {
    tessar.hook(toolHooks.before, (event) => {
      if (event.payload.tool.name === WRITE_TOOL_NAME)
        return { decision: "deny", reason: "Write tool disabled" };
    });
  }
}

export default new BlockWritePlugin();
