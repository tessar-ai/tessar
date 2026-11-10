import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { defaultProjectOptions, type Backend, type ProjectOptions } from "./project-options.js";

const backends: readonly Backend[] = ["memory", "libsql", "postgresql", "mongodb"];

export class ProjectWizard {
  constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
  ) { }

  async run(name: string): Promise<ProjectOptions | null> {
    const terminal = "isTTY" in this.input && this.input.isTTY === true &&
      "isTTY" in this.output && this.output.isTTY === true;
    const lines = createInterface({ input: this.input, output: this.output, terminal });
    const answers = lines[Symbol.asyncIterator]();
    lines.on("SIGINT", () => lines.close());

    const ask = async (question: string): Promise<string | null> => {
      this.output.write(question);
      const answer = await answers.next();
      if (answer.done) return null;
      const value = answer.value.trim().toLowerCase();
      return value === "cancel" || value.includes("\u0003") ? null : value;
    };
    const confirm = async (question: string): Promise<boolean | null> => {
      while (true) {
        const answer = await ask(`${question} (y/N): `);
        if (answer === null) return null;
        if (["y", "yes"].includes(answer)) return true;
        if (["", "n", "no"].includes(answer)) return false;
        this.output.write("Enter yes or no, or cancel to stop.\n");
      }
    };

    try {
      this.output.write(`\nConfigure ${name}. Type cancel or press Ctrl+C to stop.\n`);
      const controller = await confirm("Use Controller?");
      if (controller === null) return null;
      const options = { ...defaultProjectOptions, controller };
      if (controller) {
        const session = await confirm("Use Session?");
        if (session === null) return null;
        options.session = session;
        this.output.write("Storage backend?\n  1. Memory\n  2. libSQL\n  3. PostgreSQL\n  4. MongoDB\n");
        while (true) {
          const answer = await ask("Choose backend [1]: ");
          if (answer === null) return null;
          const backend = backends[Number(answer || "1") - 1];
          if (/^[1-4]?$/.test(answer) && backend) {
            options.backend = backend;
            break;
          }
          this.output.write("Enter a number from 1 to 4, or cancel to stop.\n");
        }
      }
      const selected = ["Agent", ...(options.controller ? ["Controller"] : []), ...(options.session ? ["Session"] : [])];
      if (options.controller) selected.push(options.backend);
      this.output.write(`\n${name}: ${selected.join(" + ")}\n`);
      return await confirm("Create project?") ? options : null;
    } finally {
      lines.close();
    }
  }
}
