import { readFile } from "node:fs/promises";

export const UTF8_BOM = "\uFEFF";
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export async function readTextFile(path: string, signal: AbortSignal): Promise<string | undefined> {
  const bytes = await readFile(path, { signal });
  try {
    const text = decoder.decode(bytes);
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  }
}
