import { invalidPatch } from "./errors.js";
import { UTF8_BOM } from "./text.js";

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const UPDATE = "*** Update File: ";
const HUNK = "@@";

export const PATCH_INSTRUCTIONS = `Supply a patch bounded by ${BEGIN} and ${END}. ` +
  `Use ${ADD}<path> with + lines for new files, or ${UPDATE}<path> with ${HUNK} hunks and exact context, - and + lines. ` +
  "Use relative paths and include enough context to locate each change uniquely.";

type EditLine = { prefix: " " | "-" | "+"; text: string };
type Hunk = { lines: EditLine[]; before: string[] };
type Change = { path: string } & ({ text: string } | { hunks: Hunk[] });
type Line = { text: string; ending: string; added?: true };

export function parsePatch(patch: string): Change[] {
  if (!patch.isWellFormed() || patch.includes("\0")) invalidPatch("Patch must be UTF-8 text");
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== BEGIN || lines.pop() !== END || lines.length === 0)
    invalidPatch("Expected a patch with begin and end markers and at least one file");

  const changes: Change[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = lines[index++]!;
    if (header.startsWith(ADD)) {
      const additions: string[] = [];
      while (lines[index]?.startsWith("+")) additions.push(lines[index++]!.slice(1) + "\n");
      changes.push({ path: header.slice(ADD.length), text: additions.join("") });
    } else if (header.startsWith(UPDATE)) {
      const hunks: Hunk[] = [];
      while (lines[index] === HUNK) {
        index++;
        const edits: EditLine[] = [];
        const before: string[] = [];
        while (index < lines.length) {
          const line = lines[index]!;
          const prefix = line[0];
          if (prefix !== " " && prefix !== "-" && prefix !== "+") break;
          const text = line.slice(1);
          edits.push({ prefix, text });
          if (prefix !== "+") before.push(text);
          index++;
        }
        if (!edits.some((line) => line.prefix !== " ")) invalidPatch("Hunk requires an addition or removal");
        hunks.push({ lines: edits, before });
      }
      if (!hunks.length) invalidPatch("Update requires an @@ hunk");
      changes.push({ path: header.slice(UPDATE.length), hunks });
    } else {
      invalidPatch(`Expected an Add File or Update File directive at line ${index + 1}`);
    }
  }
  return changes;
}

export function updateText(original: string, hunks: readonly Hunk[], path: string): string {
  const bom = original.startsWith(UTF8_BOM) ? UTF8_BOM : "";
  const text = original.slice(bom.length);
  const lines: Line[] = [];
  const parts = text.split("\n");
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (index === parts.length - 1) {
      if (part) lines.push({ text: part, ending: "" });
    } else if (part.endsWith("\r")) {
      lines.push({ text: part.slice(0, -1), ending: "\r\n" });
    } else {
      lines.push({ text: part, ending: "\n" });
    }
  }

  const defaultEnding = lines.find((line) => line.ending)?.ending ?? "\n";
  const finalEnding = lines.at(-1)?.ending ?? defaultEnding;
  const result: Line[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    let match = -1;
    if (hunk.before.length === 0) {
      if (lines.length === 0 && result.length === 0) match = 0;
    } else {
      for (let index = cursor; index <= lines.length - hunk.before.length; index++) {
        if (!hunk.before.every((line, offset) => line === lines[index + offset]!.text)) continue;
        if (match !== -1) invalidPatch(`Patch context is ambiguous: ${path}`);
        match = index;
      }
    }
    if (match === -1) invalidPatch(`Patch context was not found: ${path}`);
    while (cursor < match) result.push(lines[cursor++]!);
    const ending = lines[match]?.ending || defaultEnding;
    for (const line of hunk.lines) {
      if (line.prefix === "+") result.push({ text: line.text, ending, added: true });
      else if (line.prefix === " ") result.push(lines[cursor++]!);
      else cursor++;
    }
  }
  while (cursor < lines.length) result.push(lines[cursor++]!);
  return bom + result.map((line, index) => {
    const ending = index === result.length - 1
      ? (line.added ? finalEnding : line.ending)
      : line.ending || defaultEnding;
    return line.text + ending;
  }).join("");
}
