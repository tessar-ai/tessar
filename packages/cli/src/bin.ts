#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { TessarCLI } from "./cli.js";
import type { ScaffoldMetadata } from "./scaffolding/templates.js";

try {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const metadata = JSON.parse(await readFile(new URL("./scaffold-metadata.json", import.meta.url), "utf8")) as ScaffoldMetadata;
  await new TessarCLI(process.cwd(), metadata, manifest.version).run(process.argv.slice(2));
} catch (error) {
  console.error(`tessar: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
