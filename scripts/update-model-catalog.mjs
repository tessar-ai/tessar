import { normalizeCatalog } from "../packages/core/src/models/normalize-catalog.ts";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const sourceIndex = process.argv.indexOf("--source");
const raw =
  sourceIndex >= 0
    ? await readFile(process.argv[sourceIndex + 1], "utf8")
    : await (await fetch("https://models.dev/api.json")).text();
const output = normalizeCatalog(JSON.parse(raw), {
  revision: "sha256:" + createHash("sha256").update(raw).digest("hex"),
  fetchedAt: new Date().toISOString(),
});
const directory = new URL("../packages/core/src/models/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(
  new URL("catalog.snapshot.json", directory),
  JSON.stringify(output) + "\n",
);
console.log(
  "Vendored " +
    Object.keys(output.entries).length +
    " providers; " +
    output.revision,
);
