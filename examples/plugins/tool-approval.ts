import { defineInterruption, tool, ToolDecision, type Plugin, type PluginContext } from "@tessar/core";
import { z } from "zod";

const INTERRUPTION_VERSION = 1;
const APPROVAL_RESPONSE = z.object({ approved: z.boolean() }).strict();

export class ToolApprovalPlugin implements Plugin {
  readonly id = "tool-approval";
  readonly configurationId: string;
  private readonly tools: ReadonlySet<string>;
  private readonly approval = defineInterruption({
    id: `${this.id}:confirm`,
    version: INTERRUPTION_VERSION,
    response: {
      jsonSchema: JSON.parse(JSON.stringify(z.toJSONSchema(APPROVAL_RESPONSE))),
      parse: value => APPROVAL_RESPONSE.parse(value),
    },
    resolve: response => response.approved
      ? ToolDecision.allow()
      : ToolDecision.deny("The user declined this action."),
  });

  constructor(toolNames: readonly string[]) {
    this.tools = new Set(toolNames);
    this.configurationId = JSON.stringify([...this.tools].sort());
  }

  setup(tessar: PluginContext): void {
    tessar.interruptions.register(this.approval);
    tessar.hook(tool.before, (event, execution) => {
      if (!this.tools.has(event.payload.tool.name)) return;
      return execution.suspend(this.approval, {
        toolName: event.payload.tool.name,
        arguments: event.payload.arguments,
      });
    });
  }
}
