import { tool as toolHooks } from "../events/type.js";
import { ToolMessage, type MessageData } from "../messages/message.js";
import {
  normalizeToolOutput,
  type Tool,
  type ToolExecutionContext,
} from "../tools/tool.js";
import type { ExecutionFrame } from "./frame.js";
import type { LoopContext } from "../loop.js";
import { type ToolPreparation } from "../events/type.js";
import { MessageCodec } from "../messages/codec.js";
import { immutable } from "../json.js";
import type { ToolExecutionRecord } from "../trace/records.js";
import { TessarError, errorInfo } from "../errors.js";
import { abortable } from "./abort.js";
import { Suspension } from "./interrupt.js";
import { ToolSuspension } from "../tools/suspension.js";
import { waitForTool, suspendWaitingTool } from "./tool-suspension.js";
export async function executeTool(
  tool: Tool,
  input: unknown,
  context: ToolExecutionContext,
  response?: { value: import("../json.js").JsonValue },
): Promise<ToolMessage | ToolSuspension> {
  if (context.signal.aborted)
    throw new TessarError("Cancelled", "Tool cancelled before dispatch");
  try {
    return await abortable(
      response
        ? Promise.resolve(
            tool.resume
              ? tool.resume(response.value, input, context)
              : response.value,
          ).then((value) =>
            value instanceof ToolSuspension
              ? value
              : normalizeToolOutput(value),
          )
        : tool.execute(input, context),
      context.signal,
      () =>
        new TessarError(
          "RecoveryRequired",
          "In-flight tool cancellation has unknown external outcome",
        ),
    );
  } catch (error) {
    if (!(error instanceof TessarError))
      errorInfo(error, { source: "tool", toolName: tool.name });
    throw error;
  }
}

function pendingTools(
  frame: ExecutionFrame,
  context: LoopContext,
): ToolExecutionRecord[] {
  const records = context.rows<ToolExecutionRecord>(frame, "tool_executions");
  return frame.cp.execution!.pendingToolExecutionIds.map(
    (id) => records.find((record) => record.id === id)!,
  );
}

function toolFailure(record: ToolExecutionRecord, error: unknown): ToolMessage {
  const info = errorInfo(error);
  if (
    error instanceof Suspension ||
    [
      "StorageUnavailable",
      "CommitConflict",
      "OwnershipLost",
      "PluginError",
      "RecoveryRequired",
    ].includes(info.code) ||
    ["plugin", "storage", "provider"].includes(info.source)
  )
    throw error;
  record.status = "failed";
  record.error = errorInfo(error, {
    source: "tool",
    toolName: record.toolName,
  });
  return new ToolMessage("Tool failed: " + record.error.message);
}

function saveResult(
  record: ToolExecutionRecord,
  message: ToolMessage,
  context: LoopContext,
): void {
  record.result = MessageCodec.encode(
    normalizeToolOutput(message, record.toolCallId),
  );
  record.endedAt ??= context.clock.now();
  record.durationMs = record.startedAt
    ? Date.parse(record.endedAt) - Date.parse(record.startedAt)
    : null;
}

// Only this sequential boundary publishes messages and runs result transforms.
async function publishResults(
  frame: ExecutionFrame,
  context: LoopContext,
): Promise<void> {
  for (const record of pendingTools(frame, context)) {
    if (!record.result) break;
    let message: MessageData = record.result;
    if (!record.resultMessageId) {
      const transformed = await context.hook(
        frame,
        toolHooks.result,
        message,
        record.id,
      );
      message = MessageCodec.encode(
        transformed instanceof ToolMessage
          ? normalizeToolOutput(transformed, record.toolCallId)
          : MessageCodec.decode(transformed),
      );
      if (message.role !== "tool" || message.toolCallId !== record.toolCallId)
        throw new TessarError(
          "InvalidMessage",
          "Tool result transform changed role/correlation",
        );
      record.result = message;
      record.resultMessageId = message.id;
    }
    const existing = frame.cp.state.messages.find(
      (existing) => existing.id === message.id,
    );
    if (
      existing &&
      (existing.role !== "tool" || existing.toolCallId !== record.toolCallId)
    )
      throw new TessarError(
        "InvalidMessage",
        "Tool result ID already belongs to another message",
      );
    if (!existing) await context.appendMessage(frame, message);
    frame.cp.execution!.pendingToolExecutionIds =
      frame.cp.execution!.pendingToolExecutionIds.filter(
        (id) => id !== record.id,
      );
    frame.cp.execution!.phase = frame.cp.execution!.pendingToolExecutionIds
      .length
      ? "BeforeTool"
      : "TurnBoundary";
    await context.commit(frame, "ExecutionTransition");
    await context.hook(
      frame,
      toolHooks.end,
      {
        toolExecutionId: record.id,
        toolCallId: record.toolCallId,
        result: message,
        status: record.status,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
      },
      record.id,
    );
  }
}

export async function callTools(
  frame: ExecutionFrame,
  context: LoopContext,
): Promise<void> {
  await publishResults(frame, context);
  await suspendWaitingTool(frame, context);
  const position = frame.cp.execution!;
  const prepared: {
    record: ToolExecutionRecord;
    tool: Tool;
    input: unknown;
  }[] = [];
  const remaining =
    position.budgets.limits.maxToolCalls - position.budgets.toolCalls;
  let fresh = 0;
  for (const record of pendingTools(frame, context)) {
    if (record.result) continue;
    if (record.status === "suspended") break;
    if (!record.resume && fresh >= remaining) break;
    const tool = frame.registry.find<Tool>("tool", record.toolName);
    try {
      if (!tool)
        throw new TessarError("UnknownTool", "No registered tool executor");
      const saved =
        position.handlerCursor?.eventId === toolHooks.before &&
        (position.handlerCursor.payload as unknown as ToolPreparation)
          .toolExecutionId === record.id
          ? (position.handlerCursor.payload as unknown as ToolPreparation)
          : null;
      const payload: ToolPreparation =
        saved ??
        (record.policyDecision
          ? {
              tool: {
                name: tool.name,
                description: tool.description,
                inputSchema: tool.jsonSchema,
              },
              toolExecutionId: record.id,
              toolCallId: record.toolCallId,
              arguments: record.arguments,
            }
          : await context.hook(
              frame,
              toolHooks.prepare,
              {
                tool: {
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.jsonSchema,
                },
                toolExecutionId: record.id,
                toolCallId: record.toolCallId,
                arguments: record.arguments,
              },
              record.id,
            ));
      record.arguments = immutable(payload.arguments);
      const input = tool.schema.parse(record.arguments);
      const decision = record.policyDecision
        ? {
            decision:
              record.policyDecision.decision === "allowed"
                ? ("allow" as const)
                : ("deny" as const),
            reason: record.policyDecision.reason,
          }
        : await context.hook(
            frame,
            toolHooks.before,
            immutable(payload),
            record.id,
          );
      if (decision?.decision === "stop") {
        await context.finish(
          frame,
          "stopped",
          decision.reason ?? "PolicyStopped",
        );
        return;
      }
      record.policyDecision = {
        decision: decision?.decision === "deny" ? "denied" : "allowed",
        ...(decision?.decision === "deny" && decision.reason
          ? { reason: decision.reason }
          : {}),
      };
      if (decision?.decision === "deny") {
        record.status = "denied";
        saveResult(
          record,
          new ToolMessage(decision.reason ?? "Tool denied"),
          context,
        );
      } else {
        record.idempotencyKey =
          tool.recovery?.idempotencyKey(input, {
            toolExecutionId: record.id,
          }) ?? null;
        prepared.push({ record, tool, input });
        if (!record.resume) fresh++;
      }
    } catch (error) {
      saveResult(record, toolFailure(record, error), context);
      await context.hook(
        frame,
        toolHooks.error,
        {
          toolExecutionId: record.id,
          error: record.error!,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
        },
        record.id,
      );
    }
    await context.commit(frame, "ExecutionTransition");
  }

  let next = 0,
    waiting = false;
  const failures: { error: unknown }[] = [];
  const worker = async () => {
    while (
      !failures.length &&
      !waiting &&
      next < prepared.length &&
      !frame.sink.controller.signal.aborted
    ) {
      const { record, tool, input } = prepared[next++]!;
      const continuing = !!record.resume;
      let dispatched = false;
      try {
        record.status = "running";
        if (!continuing) record.startedAt = context.clock.now();
        if (!continuing) position.budgets.toolCalls++;
        position.phase = "ToolPending";
        await context.commit(frame, "ExecutionTransition");
        await context.hook(
          frame,
          toolHooks.start,
          {
            toolExecutionId: record.id,
            toolCallId: record.toolCallId,
            startedAt: record.startedAt,
            turnId: record.turnId,
            name: record.toolName,
            arguments: record.arguments,
          },
          record.id,
        );
        if (frame.sink.controller.signal.aborted)
          throw new TessarError("Cancelled", "Tool cancelled before dispatch");
        let result: ToolMessage | ToolSuspension;
        try {
          dispatched = true;
          result = await executeTool(
            tool,
            input,
            {
              ...context.services(frame, record.id),
              signal: frame.sink.controller.signal,
              threadId: frame.cp.threadId,
              streamId: frame.stream.id,
              turnId: record.turnId,
              toolExecutionId: record.id,
              emit: (progress) => {
                void context.hook(
                  frame,
                  toolHooks.update,
                  { toolExecutionId: record.id, progress },
                  record.id,
                );
              },
              suspend: (payload) => new ToolSuspension(payload),
            },
            continuing ? record.resume : undefined,
          );
          if (result instanceof ToolSuspension) {
            waitForTool(frame, context, record, tool, result);
            waiting = true;
            await context.commit(frame, "ExecutionTransition");
            continue;
          }
          // Bind here so an incorrect explicit correlation is reported as a tool failure.
          result = normalizeToolOutput(result, record.toolCallId);
          record.status = "succeeded";
        } catch (error) {
          result = toolFailure(record, error);
          record.endedAt = context.clock.now();
          await context.hook(
            frame,
            toolHooks.error,
            {
              toolExecutionId: record.id,
              error: record.error!,
              startedAt: record.startedAt,
              endedAt: record.endedAt,
            },
            record.id,
          );
        }
        saveResult(record, result, context);
        await context.commit(frame, "ExecutionTransition");
      } catch (error) {
        if (record.status === "running") {
          record.status = dispatched
            ? "interrupted"
            : continuing
              ? "resuming"
              : "pending";
          if (!dispatched) {
            if (!continuing) record.startedAt = null;
            if (!continuing) position.budgets.toolCalls--;
          }
        }
        failures.push({ error });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(context.toolConcurrency, prepared.length) },
      worker,
    ),
  );
  // A pre-dispatch cancellation must not hide an unknown in-flight outcome.
  const failure =
    failures.find((value) => errorInfo(value.error).code !== "Cancelled") ??
    failures[0];
  if (failure) {
    frame.stream.status = "interrupted";
    await context.commit(frame, "ExecutionTransition");
    throw failure.error;
  }
  if (frame.sink.controller.signal.aborted)
    throw new TessarError("Cancelled", "Execution cancelled");
  await publishResults(frame, context);
  await suspendWaitingTool(frame, context);
  position.phase = position.pendingToolExecutionIds.length
    ? "BeforeTool"
    : "TurnBoundary";
  await context.commit(frame, "ExecutionTransition");
  if (
    position.pendingToolExecutionIds.length &&
    position.budgets.toolCalls >= position.budgets.limits.maxToolCalls
  )
    await context.finish(frame, "stopped", "MaxToolCalls");
}

/** Reconcile each dispatched call; saved sibling results never execute again. */
export async function recoverTools(
  frame: ExecutionFrame,
  context: LoopContext,
  cancel = false,
): Promise<void> {
  for (const record of pendingTools(frame, context)) {
    if (record.result) continue;
    if (record.status === "running" || record.status === "interrupted") {
      record.status = "interrupted";
      await context.commit(frame, "ExecutionTransition");
      const tool = frame.registry.find<Tool>("tool", record.toolName);
      const outcome =
        tool?.recovery && record.idempotencyKey
          ? await tool.recovery.reconcile({
              id: record.id,
              input: tool.schema.parse(record.arguments),
              key: record.idempotencyKey,
            })
          : { status: "unknown" as const };
      if (outcome.status === "unknown") {
        frame.stream.status = "interrupted";
        await context.commit(frame, "ExecutionTransition");
        throw new TessarError(
          "RecoveryRequired",
          "Tool dispatch outcome is unknown",
        );
      }
      if (outcome.status === "completed") {
        saveResult(record, normalizeToolOutput(outcome.result), context);
        record.status = "succeeded";
      } else record.status = "pending";
    }
    if (cancel && !record.result) {
      record.status = "cancelled";
      saveResult(record, new ToolMessage("Execution cancelled"), context);
    }
    await context.commit(frame, "ExecutionTransition");
  }
  await publishResults(frame, context);
  frame.cp.execution!.phase = frame.cp.execution!.pendingToolExecutionIds.length
    ? "BeforeTool"
    : "TurnBoundary";
}
