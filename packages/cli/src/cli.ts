import { runNew } from "./commands/new.js";
import { runGenerate } from "./commands/generate.js";
import { parseArgs } from "node:util";
import type { ScaffoldMetadata } from "./scaffolding/templates.js";
import { ProjectWizard } from "./scaffolding/project-wizard.js";
import type { ProjectOptions } from "./scaffolding/project-options.js";
import { CLI_ERROR_CODE, TessarCLIError } from "./errors.js";
import { runDev } from "./commands/dev.js";

const help = `Usage:
  tessar new <name>
  tessar dev
  tessar generate <agent|tool|controller|session|plugin> <name>
  tessar g <agent|tool|controller|session|plugin> <name>

new asks about Controller, Session and storage before creating files.
Answer the prompts or pipe answers on stdin; cancel/EOF creates nothing.

Plugin options:
  --type basic|tool|hook|provider|storage|capability (default: basic)
  --event <event>  Required for hook, e.g. context.prepare or tool.before

Names use lowercase kebab-case. Generated files go into src/agents, src/tools,
src/controllers, src/sessions or src/plugins. Existing files are never overwritten.
  --help, -h      Show help
  --version, -v   Show version`;

export class TessarCLI {
  constructor(
    private readonly cwd: string,
    private readonly metadata: ScaffoldMetadata,
    private readonly version: string,
    private readonly print: (message: string) => void = console.log,
    private readonly chooseProject: (name: string) => Promise<ProjectOptions | null> = (name) => new ProjectWizard().run(name),
  ) { }

  async run(args: readonly string[]): Promise<void> {
    if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]!))) {
      this.print(help);
      return;
    }
    if (args.length === 1 && ["--version", "-v"].includes(args[0]!)) {
      this.print(this.version);
      return;
    }
    const { positionals, values } = parseArgs({
      args: [...args], allowPositionals: true,
      options: { type: { type: "string" }, event: { type: "string" } },
    });
    const [command, ...rest] = positionals;
    if (command === "dev") {
      if (rest.length || Object.keys(values).length) throw new TessarCLIError(CLI_ERROR_CODE.INVALID_ARGUMENTS, "Usage: tessar dev");
      await runDev(this.cwd);
      return;
    }
    if (command === "new") {
      if (rest.length !== 1 || Object.keys(values).length) throw new TessarCLIError(CLI_ERROR_CODE.INVALID_ARGUMENTS, "Usage: tessar new <name>");
      await runNew(rest[0], { cwd: this.cwd, metadata: this.metadata, print: this.print, chooseProject: this.chooseProject });
      return;
    }
    if (command !== "g" && command !== "generate") throw new TessarCLIError(CLI_ERROR_CODE.INVALID_ARGUMENTS, `Unknown command: ${command}. Run tessar --help.`);
    if (rest.length !== 2) throw new TessarCLIError(CLI_ERROR_CODE.INVALID_ARGUMENTS, "Usage: tessar generate <kind> <name>");
    const [kind, name] = rest;
    await runGenerate(kind!, name, values, { cwd: this.cwd, metadata: this.metadata, print: this.print });
  }
}
