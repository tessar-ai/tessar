import { arch, platform, release } from "node:os";
import { buildInstruction, context, type Plugin, type PluginContext } from "@tessar/core";

const ENVIRONMENT_ORDER = 1000;

export class EnvironmentContextPlugin implements Plugin {
  readonly id = "environment-context";

  setup(tessar: PluginContext): void {
    tessar.hook(context.prepare, event => ({
      ...event.payload,
      instructions: buildInstruction([
        ...event.payload.instructions.sections,
        {
          id: this.id,
          order: ENVIRONMENT_ORDER,
          content: [
            '<environment-context/>',
            `Current time (UTC): ${new Date().toISOString()}`,
            `Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
            `Operating system: ${platform()} ${release()}`,
            `Architecture: ${arch()}`,
            `Node.js: ${process.version}`,
            `Working directory: ${process.cwd()}`,
            `</environment-context>`
          ].join("\n"),
        },
      ]),
    }));
  }
}
