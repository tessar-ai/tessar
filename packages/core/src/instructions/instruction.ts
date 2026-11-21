import { fail, requireId } from "../errors.js";
import { immutable } from "../helpers/json.js";
export interface InstructionSection {
  readonly id: string;
  readonly content: string;
  /** Lower values come first; omitted values compare as zero. IDs break ties. */
  readonly order?: number;
}
export interface Instruction {
  readonly sections: readonly InstructionSection[];
}
export function buildInstruction(
  sections: readonly InstructionSection[],
): Instruction {
  const ids = new Set<string>();
  for (const section of sections) {
    requireId(section.id, "section id");
    if (
      typeof section.content !== "string" ||
      ids.has(section.id) ||
      (section.order !== undefined && !Number.isFinite(section.order))
    )
      fail(
        "InvalidConfiguration",
        "Instruction sections need unique ids, string content and finite numeric order",
      );
    ids.add(section.id);
  }
  return immutable({
    sections: sections
      .map<InstructionSection>(({ order, ...section }) =>
        order === undefined ? section : { ...section, order },
      )
      .sort(
        (a, b) =>
          (a.order ?? 0) - (b.order ?? 0) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      ),
  });
}
export function normalizeInstruction(
  value: string | Instruction = "",
): Instruction {
  return buildInstruction(
    typeof value === "string"
      ? [{ id: "default", content: value }]
      : value.sections,
  );
}
