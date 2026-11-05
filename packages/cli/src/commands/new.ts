import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { projectFiles, type ScaffoldMetadata } from "../scaffolding/templates.js";
import type { ProjectOptions } from "../scaffolding/project-options.js";
import { validateName, writeProjectFile } from "../scaffolding/files.js";
import { CLI_ERROR_CODE, TessarCLIError } from "../errors.js";

export async function runNew(name: string | undefined, { cwd, metadata, print, chooseProject }: {
  cwd: string;
  metadata: ScaffoldMetadata;
  print: (message: string) => void;
  chooseProject: (name: string) => Promise<ProjectOptions | null>;
}): Promise<void> {
  validateName(name);
  const target = join(cwd, name);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing) throw new TessarCLIError(CLI_ERROR_CODE.TARGET_EXISTS, `Target already exists: ${name}`);
  const options = await chooseProject(name);
  if (!options) {
    print("Project creation cancelled.");
    return;
  }
  const files = projectFiles(name, metadata, options);
  await mkdir(target);
  for (const [path, content] of Object.entries(files)) await writeProjectFile(target, path, content);
  print(`Created ${name}.\n\n  cd ${name}\n  npm install\n\nCopy .env.example to .env and fill in the model and selected backend settings.\nThen run: npm start -- "Hello!"`);
}
