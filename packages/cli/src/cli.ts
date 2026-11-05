import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { componentFile, projectFiles, type ScaffoldMetadata } from "./templates.js";
import { ProjectWizard } from "./project-wizard.js";
import type { ProjectOptions } from "./project-options.js";
import { CLI_ERROR_CODE, TessarCLIError } from "./errors.js";

const help = `Usage:
  tessar new <name>
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

function validateName(name: string | undefined): asserts name is string {
  if (!name || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name) || name.length > 100) {
    throw new TessarCLIError(CLI_ERROR_CODE.INVALID_NAME, "Use a lowercase kebab-case name, at most 100 characters (no paths or reserved device names).");
  }
}

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
    if (command === "new") {
      if (rest.length !== 1 || Object.keys(values).length) throw new TessarCLIError(CLI_ERROR_CODE.INVALID_ARGUMENTS, "Usage: tessar new <name>");
      const name = rest[0];
      validateName(name);
      const target = join(this.cwd, name);
      const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (existing) throw new TessarCLIError(CLI_ERROR_CODE.TARGET_EXISTS, `Target already exists: ${name}`);
      const options = await this.chooseProject(name);
      if (!options) {
        this.print("Project creation cancelled.");
        return;
      }
      const files = projectFiles(name, this.metadata, options);
      await mkdir(target);
      for (const [path, content] of Object.entries(files)) await this.write(target, path, content);
      this.print(`Created ${name}.\n\n  cd ${name}\n  npm install\n\nCopy .env.example to .env and fill in the model and selected backend settings.\nThen run: npm start -- "Hello!"`);
      return;
    }
    if (command !== "g" && command !== "generate") throw new TessarCLIError(CLI_ERROR_CODE.INVALID_ARGUMENTS, `Unknown command: ${command}. Run tessar --help.`);
    if (rest.length !== 2) throw new TessarCLIError(CLI_ERROR_CODE.INVALID_ARGUMENTS, "Usage: tessar generate <kind> <name>");
    const [kind, name] = rest;
    validateName(name);
    const file = componentFile(kind!, name, values, this.metadata);
    try {
      JSON.parse(await readFile(join(this.cwd, "package.json"), "utf8"));
    } catch (cause) {
      throw new TessarCLIError(CLI_ERROR_CODE.INVALID_PROJECT, "Run generators from a project root containing a valid package.json.", { cause });
    }
    await this.write(this.cwd, file.path, file.content);
    this.print(`Created ${file.path}. Import and use it in your project.`);
  }

  private async write(root: string, path: string, content: string): Promise<void> {
    const base = await realpath(root);
    const destination = join(base, path);
    const parts = relative(base, dirname(destination)).split(/[\\/]/).filter(Boolean);
    let parent = base;
    for (const part of parts) {
      parent = join(parent, part);
      await mkdir(parent).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const resolved = await realpath(parent);
      const offset = relative(base, resolved);
      if (offset === ".." || offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(offset)) {
        throw new TessarCLIError(CLI_ERROR_CODE.UNSAFE_PATH, `Refusing to write outside the project: ${path}`);
      }
    }
    await writeFile(destination, content, { flag: "wx" });
  }
}
