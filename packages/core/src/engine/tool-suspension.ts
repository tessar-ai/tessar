import { ExecutionPhase } from "../state/schema.js";
import { stream } from "../events/type.js";
import { fail } from "../errors.js";
import { canonicalJson } from "../state/commit.js";
import type { InterruptRecord } from "../state/schema.js";
import type { ToolExecutionRecord } from "../trace/records.js";
import type { Tool } from "../tools/tool.js";
import type { ToolSuspension } from "../tools/suspension.js";
import type { LoopContext } from "../loop.js";
import type { ExecutionFrame } from "./frame.js";
import { Suspension } from "./interrupt.js";

export function waitForTool(
  frame: ExecutionFrame,
  context: LoopContext,
  record: ToolExecutionRecord,
  tool: Tool,
  result: ToolSuspension,
): void {
  const registration = frame.registry.values.find(
    (r) => r.kind === "tool" && r.id === tool.name,
  )!;
  const request: InterruptRecord = {
    kind: "tool-result",
    id: context.ids.next("interrupt"),
    threadId: frame.cp.threadId,
    streamId: frame.stream.id,
    checkpointId: frame.cp.id,
    definitionId: tool.name,
    definitionVersion: registration.version,
    pluginId: registration.pluginId,
    payload: result.payload,
    responseSchema: tool.resumeJsonSchema,
    actionRef: {
      toolExecutionId: record.id,
      toolName: tool.name,
      argumentsDigest: canonicalJson(record.arguments),
    },
    status: "pending",
    response: null,
    resolvedDecision: null,
    createdAt: context.clock.now(),
    resolvedAt: null,
    revision: frame.cp.revision,
  };
  delete record.resume;
  record.status = "suspended";
  context.put(frame, "interrupts", request);
}

/** Activate one request only after dispatched siblings have settled. */
export async function suspendWaitingTool(
  frame: ExecutionFrame,
  context: LoopContext,
): Promise<void> {
  const records = context.rows<ToolExecutionRecord>(frame, "tool_executions");
  const first = frame.cp
    .execution!.pendingToolExecutionIds.map(
      (id) => records.find((r) => r.id === id)!,
    )
    .find((r) => !r.result);
  if (first?.status !== "suspended") return;
  const request = context
    .rows<InterruptRecord>(frame, "interrupts")
    .find(
      (r) =>
        r.kind === "tool-result" &&
        r.status === "pending" &&
        r.actionRef?.toolExecutionId === first.id,
    );
  if (!request) fail("InvalidTransition", "Waiting tool request is missing");
  frame.cp.execution!.pendingInterruptId = request.id;
  frame.cp.execution!.phase = ExecutionPhase.Suspended;
  frame.stream.status = "suspended";
  await context.commit(frame, "Suspended");
  await context.hook(frame, stream.suspended, {
    checkpointId: frame.cp.id,
    interrupt: request,
  });
  throw new Suspension();
}
