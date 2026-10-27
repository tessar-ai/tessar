import { provider } from "../events/type.js";
import type { ModelCallContext, ModelRef } from "../models/contract.js";
import type { ModelAttemptRecord } from "../trace/records.js";
import type { LoopContext } from "../loop.js";
import type { ExecutionFrame } from "./frame.js";

/** Bind native request preparation to one attempt, including concurrent helpers. */
export function providerRequest(
  context: Pick<LoopContext, "hook">,
  frame: ExecutionFrame,
  model: ModelRef,
  attempt: ModelAttemptRecord,
  toolExecutionId?: string,
): NonNullable<ModelCallContext["prepareRequest"]> {
  return async (protocol, body) => {
    const result = await context.hook(
      frame,
      provider.request,
      {
        model,
        protocol,
        attemptId: attempt.id,
        purpose: attempt.purpose,
        body,
      },
      toolExecutionId,
    );
    frame.sink.controller.signal.throwIfAborted();
    return result.body;
  };
}
