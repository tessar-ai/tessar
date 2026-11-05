import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { componentFile, type ScaffoldMetadata } from "../scaffolding/templates.js";
import { validateName, writeProjectFile } from "../scaffolding/files.js";
import { CLI_ERROR_CODE, TessarCLIError } from "../errors.js";

export async function runGenerate(kind: string, name: string | undefined, options: { type?: string; event?: string },
  { cwd, metadata, print }: { cwd: string; metadata: ScaffoldMetadata; print: (message: string) => void },
): Promise<void> {
  validateName(name);
  const file = componentFile(kind, name, options, metadata);
  try {
    JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  } catch (cause) {
    throw new TessarCLIError(CLI_ERROR_CODE.INVALID_PROJECT, "Run generators from a project root containing a valid package.json.", { cause });
  }
  await writeProjectFile(cwd, file.path, file.content);
  print(`Created ${file.path}. Import and use it in your project.`);
}
