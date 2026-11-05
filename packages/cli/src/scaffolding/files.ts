import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { CLI_ERROR_CODE, TessarCLIError } from "../errors.js";

export function validateName(name: string | undefined): asserts name is string {
  if (!name || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name) || name.length > 100) {
    throw new TessarCLIError(CLI_ERROR_CODE.INVALID_NAME, "Use a lowercase kebab-case name, at most 100 characters (no paths or reserved device names).");
  }
}

export async function writeProjectFile(root: string, path: string, content: string): Promise<void> {
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
