import { bindExecutionModel } from "../models/stream.js";
import { model as modelHooks } from "../events/type.js";

import type { StreamRecord, ToolExecutionRecord } from "../trace/records.js";
import type { Attachment } from "./delivery.js";
import {
  createFrame,
  loadRecords,
  type ExecutionContext,
  type ExecutionFrame,
  type ExecutionRequest,
} from "./frame.js";
import { planRecovery } from "./recovery.js";
import { recoverTools } from "./tool-executor.js";
import { TessarError, fail } from "../errors.js";
import { assertJson, immutable, type JsonValue } from "../json.js";
import type { Tool } from "../tools/tool.js";
import { canonicalJson } from "../state/commit.js";
import type { StorageBackend } from "../state/storage-ports.js";
import type { RegistryLease } from "../plugins/registry.js";
import type { InterruptionDefinition } from "./interrupt.js";
import type { ControlDecision } from "../events/type.js";
import { validateDecision } from "../events/decision.js";
import type { ExecutionPhase, InterruptRecord } from "../state/schema.js";
export function phaseForEvent(id: string): ExecutionPhase {
  const phases: Record<string, ExecutionPhase> = {
    "stream.before": "BeforeTurn",
    "tool.before": "BeforeTool",
    "model.select": "BeforeModel",
    "model.recover": "ModelPending",
    "turn.decision": "TurnBoundary",
  };
  return (
    phases[id] ??
    fail("ResumeIncompatible", "Unsupported interruption boundary")
  );
}
export function validateManifest(
  manifest: readonly {
    kind: string;
    id: string;
    version: number;
    requiredForContinuation: boolean;
    pluginVersion?: number;
    configurationId?: string | null;
  }[],
  registry: RegistryLease,
  modelOverride?: { providerId: string },
): void {
  for (const requirement of manifest) {
    if (!requirement.requiredForContinuation) continue;
    if (requirement.kind === "provider" && modelOverride) continue;
    const present =
      requirement.kind === "handler"
        ? registry.handlers.find(
            (r) => r.id === requirement.id && r.version === requirement.version,
          )
        : registry.values.find(
            (r) =>
              r.kind === requirement.kind &&
              r.id === requirement.id &&
              r.version === requirement.version,
          );
    if (!present)
      fail(
        "ResumeIncompatible",
        "Required contract is missing: " + requirement.id,
      );
    if (
      (requirement.pluginVersion !== undefined &&
        present.pluginVersion !== requirement.pluginVersion) ||
      (requirement.configurationId !== undefined &&
        present.configurationId !== requirement.configurationId)
    )
      fail("ResumeIncompatible", "Plugin configuration/version changed");
  }
}
export async function validateResume(
  backend: StorageBackend,
  registry: RegistryLease,
  threadId: string,
  interruptId: string,
  value: JsonValue,
): Promise<{
  interrupt: InterruptRecord;
  decision: ControlDecision | null;
  value?: JsonValue;
}> {
  const interrupt = await backend.executions.get("interrupts", interruptId, {
    threadId,
  });
  if (!interrupt)
    fail("InterruptNotFound", "Interrupt does not belong to thread");
  if (interrupt.status !== "pending")
    fail("AlreadyResumed", "Interrupt already consumed");
  if (interrupt.kind === "tool-result") {
    const registration = registry.values.find(
      (r) => r.kind === "tool" && r.id === interrupt.definitionId,
    );
    const tool = registration?.value as Tool | undefined;
    if (
      !tool ||
      registration!.pluginId !== interrupt.pluginId ||
      registration!.version !== interrupt.definitionVersion ||
      canonicalJson(tool.resumeJsonSchema) !==
        canonicalJson(interrupt.responseSchema)
    )
      fail("ResumeIncompatible", "Waiting tool contract changed");
    try {
      const parsed = tool.resumeSchema ? tool.resumeSchema.parse(value) : value;
      assertJson(parsed);
      return {
        interrupt,
        decision: null,
        value: immutable(parsed) as JsonValue,
      };
    } catch {
      fail(
        "InvalidResumeResponse",
        "Response does not satisfy tool resume schema",
      );
    }
  }
  const binding = registry.find<{
    definition: InterruptionDefinition;
    pluginId: string;
  }>("interruption", interrupt.definitionId);
  if (
    !binding ||
    binding.pluginId !== interrupt.pluginId ||
    binding.definition.version !== interrupt.definitionVersion
  )
    fail(
      "ResumeIncompatible",
      "Interruption definition is missing or incompatible",
    );
  let decision: ControlDecision;
  try {
    const parsed = binding.definition.response.parse(value);
    decision = binding.definition.resolve(parsed, interrupt.payload);
    immutable(decision);
  } catch (error) {
    throw new TessarError(
      "InvalidResumeResponse",
      "Response does not satisfy interruption contract",
    );
  }
  if ((decision as ControlDecision).decision === "suspend")
    fail("InvalidResumeResponse", "Resolver must return a resolved decision");
  return { interrupt, decision: immutable(decision) };
}

export async function restoreFrame(
  execution: ExecutionContext,
  request: Extract<ExecutionRequest, { kind: "recover" }>,
  sink: Attachment,
  registry: RegistryLease,
  checkManifest = true,
): Promise<ExecutionFrame> {
  const head = await execution.runtime.backend.threads.get(request.threadId);
  if (!head) fail("ThreadNotFound", "Thread not found");
  const stored = await execution.runtime.backend.executions.get(
    "streams",
    request.streamId,
    { threadId: request.threadId },
  );
  if (!stored) fail("StreamNotFound", "Execution not found");
  if (["completed", "failed", "stopped", "cancelled"].includes(stored.status))
    fail("AlreadyTerminal", "Execution already ended");
  const cp = structuredClone(
    (await execution.runtime.backend.checkpoints.get(
      head.currentCheckpointId,
    ))!,
  );
  if (cp.execution?.streamId !== request.streamId)
    fail("InvalidTransition", "Execution is not current thread work");
  if (checkManifest)
    validateManifest(cp.execution.registryManifest, registry, request.model);
  const lease = await execution.runtime.backend.ownership.acquire({
    threadId: request.threadId,
    ownerToken: execution.ids.next("owner"),
    ttlMs: 30000,
  });
  try {
    const records = await loadRecords(execution, request.threadId);
    const stream = (
      records.get("streams:" + request.streamId) as { data: StreamRecord }
    ).data;
    const frame = createFrame(execution, {
      request,
      sink,
      registry,
      lease,
      cp,
      stream,
      records,
      admitted: true,
    });
    if (checkManifest)
      bindExecutionModel(
        registry,
        cp.execution!,
        frame.request.adapter,
        request.model,
      );
    sink.setId(stream.id);
    return frame;
  } catch (error) {
    await execution.runtime.backend.ownership.release(lease);
    throw error;
  }
}

export async function prepareRecovery(
  execution: ExecutionContext,
  request: Extract<ExecutionRequest, { kind: "recover" }>,
  sink: Attachment,
  registry: RegistryLease,
): Promise<ExecutionFrame> {
  const frame = await restoreFrame(execution, request, sink, registry);
  try {
    const plan = planRecovery(
      frame.cp,
      execution.rows(frame, "model_attempts"),
      execution.rows(frame, "tool_executions"),
    );
    if (plan.kind === "pending-interrupt") {
      if (request.model) await execution.commit(frame, "ExecutionTransition");
      return frame;
    }
    frame.stream.status = "interrupted";
    if (plan.kind === "incompatible")
      fail("ResumeIncompatible", "Invalid recovery cursor");
    if (plan.kind === "model") {
      plan.attempt.status = "interrupted";
      plan.attempt.endedAt = execution.clock.now();
      plan.attempt.error = {
        source: "tessar",
        name: "TessarError",
        code: "InterruptedModelCall",
        message: "Provider outcome was not committed",
        retryable: true,
      };
      await execution.commit(frame, "ExecutionTransition");
      const decision = await execution.hook(frame, modelHooks.recover, {
        attemptId: plan.attempt.id,
        error: plan.attempt.error,
      });
      if (decision?.decision !== "retry")
        fail(
          "RecoveryRequired",
          "Model retry requires an explicit recovery policy",
        );
      frame.cp.execution!.phase = "BeforeModel";
    }
    if (plan.kind === "tools") await recoverTools(frame, execution);
    frame.stream.status = "running";
    await execution.commit(frame, "Resumed");
    return frame;
  } catch (error) {
    await execution.runtime.backend.ownership.release(frame.lease);
    throw error;
  }
}

export async function prepareResume(
  execution: ExecutionContext,
  request: Extract<ExecutionRequest, { kind: "resume" }>,
  sink: Attachment,
  registry: RegistryLease,
): Promise<ExecutionFrame> {
  const existing = execution.resumeAdmissions.get(request.interruptId);
  if (existing) {
    await existing;
    fail("AlreadyResumed", "Another response was already committed");
  }
  const pending = prepareResumeFrame(execution, request, sink, registry);
  execution.resumeAdmissions.set(request.interruptId, pending);
  try {
    return await pending;
  } finally {
    execution.resumeAdmissions.delete(request.interruptId);
  }
}

async function prepareResumeFrame(
  execution: ExecutionContext,
  request: Extract<ExecutionRequest, { kind: "resume" }>,
  sink: Attachment,
  registry: RegistryLease,
): Promise<ExecutionFrame> {
  await validateResume(
    execution.runtime.backend,
    registry,
    request.threadId,
    request.interruptId,
    request.value,
  );
  const head = await execution.runtime.backend.threads.get(request.threadId);
  if (!head) fail("ThreadNotFound", "Thread not found");
  const stored = (await execution.runtime.backend.checkpoints.get(
    head.currentCheckpointId,
  ))!;
  if (
    !stored.execution ||
    stored.execution.pendingInterruptId !== request.interruptId
  )
    fail("InvalidTransition", "Thread is not waiting for this interruption");
  validateManifest(stored.execution.registryManifest, registry, request.model);
  const lease = await execution.runtime.backend.ownership.acquire({
    threadId: request.threadId,
    ownerToken: execution.ids.next("owner"),
    ttlMs: 30000,
  });
  try {
    const { interrupt, decision, value } = await validateResume(
      execution.runtime.backend,
      registry,
      request.threadId,
      request.interruptId,
      request.value,
    );
    const cp = structuredClone(stored),
      records = await loadRecords(execution, request.threadId);
    if (interrupt.kind !== "tool-result") {
      const eventId = cp.execution?.handlerCursor?.eventId;
      if (!eventId) fail("ResumeIncompatible", "Missing continuation cursor");
      try {
        validateDecision(eventId, decision);
      } catch {
        fail(
          "InvalidResumeResponse",
          "Resolved decision is invalid for " + eventId,
        );
      }
    }
    const stream = (
      records.get("streams:" + interrupt.streamId) as { data: StreamRecord }
    ).data;
    let waitingTool: ToolExecutionRecord | undefined;
    if (interrupt.actionRef?.toolExecutionId) {
      const tool = execution
        .rows<ToolExecutionRecord>(
          { records } as ExecutionFrame,
          "tool_executions",
        )
        .find((t) => t.id === interrupt.actionRef!.toolExecutionId);
      if (
        !tool ||
        canonicalJson(tool.arguments) !== interrupt.actionRef.argumentsDigest
      )
        fail("ResumeIncompatible", "Pending operation payload changed");
      waitingTool = tool;
    }
    const frame = createFrame(execution, {
      request,
      sink,
      registry,
      lease,
      cp,
      stream,
      records,
      admitted: true,
    });
    const position = cp.execution!,
      cursor = position.handlerCursor;
    bindExecutionModel(
      registry,
      position,
      frame.request.adapter,
      request.model,
    );
    let resolved = decision;
    if (interrupt.kind === "tool-result") {
      if (!waitingTool || waitingTool.status !== "suspended")
        fail("ResumeIncompatible", "Tool is not waiting for a response");
      waitingTool.resume = { interruptId: interrupt.id, value: value! };
      waitingTool.status = "resuming";
      position.handlerCursor = null;
      position.phase = "BeforeTool";
    } else {
      if (!cursor) fail("ResumeIncompatible", "Missing continuation cursor");
      const previous = cursor.decisions.at(-2) as ControlDecision | undefined;
      resolved =
        previous && ["deny", "stop"].includes(previous.decision)
          ? previous
          : decision;
      cursor.decisions = [
        ...cursor.decisions.slice(0, -1),
        resolved as unknown as JsonValue,
      ];
      position.phase = phaseForEvent(cursor.eventId);
    }
    position.pendingInterruptId = null;
    if (request.model) {
      position.registryManifest = position.registryManifest.filter(
        (r) => r.kind !== "provider",
      );
      const provider = registry.values.find(
        (r) => r.kind === "provider" && r.id === request.model!.providerId,
      );
      if (!provider) fail("MissingProvider", "Override model provider missing");
      position.registryManifest = [
        ...position.registryManifest,
        {
          pluginId: provider.pluginId,
          kind: provider.kind,
          id: provider.id,
          version: provider.version,
          requiredForContinuation: true,
        },
      ];
    }
    stream.status = "running";
    execution.put(frame, "interrupts", {
      ...interrupt,
      status: "resolved",
      response: request.value,
      resolvedDecision: resolved as unknown as JsonValue,
      resolvedAt: execution.clock.now(),
      revision: cp.revision + 1,
    });
    sink.setId(stream.id);
    await execution.commit(frame, "Resumed");
    return frame;
  } catch (error) {
    await execution.runtime.backend.ownership.release(lease);
    throw error;
  }
}
