import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fail, requireId } from "@tessar/core";
import { TessarRagError } from "../errors.js";
import type { ReadSource } from "./types.js";
import { keys, object } from "./validation.js";

export const MIME_TYPE = {
  TEXT: "text/plain",
  MARKDOWN: "text/markdown",
  HTML: "text/html",
  JSON: "application/json",
  CSV: "text/csv",
  PDF: "application/pdf",
  DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

const INVALID_CONFIGURATION = "InvalidConfiguration";

const extensions: Record<string, string> = {
  ".txt": MIME_TYPE.TEXT,
  ".md": MIME_TYPE.MARKDOWN,
  ".markdown": MIME_TYPE.MARKDOWN,
  ".html": MIME_TYPE.HTML,
  ".htm": MIME_TYPE.HTML,
  ".json": MIME_TYPE.JSON,
  ".csv": MIME_TYPE.CSV,
  ".pdf": MIME_TYPE.PDF,
  ".docx":
    MIME_TYPE.DOCX,
  ".xlsx": MIME_TYPE.XLSX,
};
const aliases: Record<string, string> = {
  "text/x-markdown": MIME_TYPE.MARKDOWN,
  "application/xhtml+xml": MIME_TYPE.HTML,
  "text/json": MIME_TYPE.JSON,
  "application/csv": MIME_TYPE.CSV,
};
const supported = new Set(Object.values(extensions));

export function mimeOf(value: string): string {
  const mime = value.split(";", 1)[0]!.trim().toLowerCase();
  const normalized = aliases[mime] ?? mime;
  if (!supported.has(normalized))
    fail("UnsupportedFormat", "Unsupported content type: " + mime);
  return normalized;
}

function fileMime(path: string): string {
  const mime = extensions[extname(path).toLowerCase()];
  if (!mime)
    fail("UnsupportedFormat", "Unsupported file extension: " + extname(path));
  return mime;
}

/** Snapshot caller-owned values before any asynchronous source acquisition. */
export function snapshotSource(value: unknown): ReadSource {
  object(value, "source");
  const variants = ["path", "url", "text", "data"].filter((key) =>
    Object.hasOwn(value, key),
  );
  if (variants.length !== 1)
    fail(
      INVALID_CONFIGURATION,
      "Provide exactly one source: path, url, text or data",
    );
  const kind = variants[0]!;
  keys(value, kind === "text" || kind === "data" ? [kind, "mimeType"] : [kind]);
  if (kind === "path")
    return { path: requireId(value.path as string, "source path") };
  if (kind === "url") {
    const address = requireId(value.url as string, "source URL");
    let url: URL;
    try {
      url = new URL(address);
    } catch (cause) {
      throw new TessarRagError(INVALID_CONFIGURATION, "Invalid source URL", {
        cause,
      });
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      fail(
        INVALID_CONFIGURATION,
        "source URL must be an HTTP(S) URL without credentials",
      );
    return { url: url.href };
  }
  if (kind === "text") {
    if (typeof value.text !== "string")
      fail(INVALID_CONFIGURATION, "source text must be a string");
    if (value.mimeType !== undefined)
      requireId(value.mimeType as string, "source MIME type");
    return {
      text: value.text,
      ...(value.mimeType === undefined
        ? {}
        : { mimeType: value.mimeType as string }),
    };
  }
  if (!(value.data instanceof Uint8Array))
    fail(INVALID_CONFIGURATION, "source data must be Uint8Array");
  return {
    data: new Uint8Array(value.data),
    mimeType: requireId(value.mimeType as string, "source MIME type"),
  };
}

export interface LoadedSource {
  data: string | Uint8Array;
  mimeType: string;
  uri?: string;
}

export async function loadSource(
  source: ReadSource,
  signal: AbortSignal,
): Promise<LoadedSource> {
  signal.throwIfAborted();
  if ("text" in source && source.text !== undefined)
    return {
      data: source.text,
      mimeType: mimeOf(source.mimeType ?? MIME_TYPE.TEXT),
    };
  if ("data" in source && source.data !== undefined)
    return { data: source.data, mimeType: mimeOf(source.mimeType) };
  if ("path" in source && source.path !== undefined) {
    const path = resolve(source.path),
      mimeType = fileMime(path);
    return {
      data: await readFile(path, { signal }),
      mimeType,
      uri: pathToFileURL(path).href,
    };
  }
  const response = await fetch(source.url!, { signal });
  try {
    if (!response.ok)
      throw new TessarRagError(
        "SourceReadFailed",
        `HTTP ${response.status} while reading source`,
        {
          source: "provider",
          details: { status: response.status, url: response.url },
        },
      );
    const type = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const mimeType =
      !type || type === "application/octet-stream"
        ? fileMime(new URL(response.url).pathname)
        : mimeOf(type);
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      mimeType,
      uri: response.url,
    };
  } finally {
    if (response.body && !response.body.locked)
      await response.body.cancel().catch(() => { });
  }
}
