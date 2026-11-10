import { ExecutionPhase } from "../state/schema.js";
import type { Checkpoint } from "../state/schema.js";
import type {
  ModelAttemptRecord,
  ToolExecutionRecord,
} from "../trace/records.js";
export type RecoveryPlan =
  | { kind: "continue" }
  | { kind: "pending-interrupt" }
  | { kind: "model"; attempt: ModelAttemptRecord }
  | { kind: "tools" }
  | { kind: "incompatible" };
export function planRecovery(
  checkpoint: Checkpoint,
  attempts: readonly ModelAttemptRecord[],
  tools: readonly ToolExecutionRecord[],
): RecoveryPlan {
  const position = checkpoint.execution;
  if (!position) return { kind: "incompatible" };
  if (position.pendingInterruptId) return { kind: "pending-interrupt" };
  if (position.phase === ExecutionPhase.ModelPending) {
    const attempt = attempts
      .filter((a) => a.turnId === position.turnId && a.purpose === "primary")
      .at(-1);
    return attempt ? { kind: "model", attempt } : { kind: "incompatible" };
  }
  if (position.phase === ExecutionPhase.ToolPending) {
    return position.pendingToolExecutionIds.length &&
      position.pendingToolExecutionIds.every((id) =>
        tools.some((tool) => tool.id === id),
      )
      ? { kind: "tools" }
      : { kind: "incompatible" };
  }
  return { kind: "continue" };
}
