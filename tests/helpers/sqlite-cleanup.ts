import { rm } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

/** Test artifacts only; production storage never deletes database files. */
export async function removeSqliteTestDirectory(directory: string, _options?: import("node:fs").RmOptions): Promise<void> {
  const target = resolve(directory);
  const location = relative(resolve(tmpdir()), target);
  if (!location || location.startsWith("..") || isAbsolute(location) || !basename(target).startsWith("tessar"))
    throw new Error("Refusing to remove a directory outside generated Tessar test artifacts");
  try {
    await rm(target, { recursive: true, force: true });
  } catch (error) {
    // shortcut: libsql 0.5.x retains some Windows handles; clean temp files after process exit until the driver fixes close.
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
  }
}
