import {
  buildInstruction,
  type Instruction,
} from "../instructions/instruction.js";
import { immutable } from "../helpers/json.js";
import type {
  ModelRef,
  ModelRequest,
  ToolDescription,
} from "../models/contract.js";
import type { Checkpoint } from "../state/schema.js";
export function buildContext(
  checkpoint: Checkpoint,
  instructions: Instruction,
  tools: readonly ToolDescription[],
  model: ModelRef,
): ModelRequest {
  const sections = [
    ...instructions.sections.map((s) => ({ ...s, id: "agent:" + s.id })),
    ...(checkpoint.state.instructions?.sections ?? []).map((s) => ({
      ...s,
      id: "thread:" + s.id,
    })),
  ];
  return immutable({
    model,
    instructions: buildInstruction(sections),
    messages: checkpoint.state.messages,
    tools,
  });
}
