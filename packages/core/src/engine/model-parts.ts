import type { LoopContext } from "../loop.js";
import type { ExecutionFrame } from "./frame.js";
import type { ModelPartChunk } from "../models/contract.js";
import type { ModelAttemptRecord } from "../trace/records.js";

/** Publish once for primary and helper calls, including iterator cleanup. */
export function observeParts(
  context: Pick<LoopContext, "hook" | "clock">,
  frame: ExecutionFrame,
  attempt: ModelAttemptRecord,
  started: number,
  toolExecutionId?: string,
) {
  return async (chunk: ModelPartChunk): Promise<void> => {
    if (
      (chunk.type === "text.delta" || chunk.type === "reasoning.delta") &&
      chunk.delta &&
      attempt.firstOutputAt === null
    ) {
      attempt.firstOutputAt = context.clock.now();
      attempt.timeToFirstOutputMs = Math.max(0, performance.now() - started);
    }
    const { type, ...payload } = chunk;
    await context.hook(
      frame,
      type,
      {
        ...payload,
        attemptId: attempt.id,
        purpose: attempt.purpose,
        parentToolExecutionId: attempt.parentToolExecutionId,
      },
      toolExecutionId,
    );
  };
}
