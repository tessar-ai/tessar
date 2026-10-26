import {
  stream as streamHooks,
  model as modelHooks,
  input as inputHooks,
} from "../events/type.js";
import { TessarError, errorInfo, errorFromInfo, fail } from "../errors.js";

import type { RegistryLease } from "../plugins/registry.js";
import type { Lease } from "../state/storage-ports.js";
import type { ModelAttemptRecord, StreamRecord } from "../trace/records.js";
import { aggregateUsage } from "../trace/usage.js";
import { bindExecutionModel } from "../models/stream.js";
import { loop } from "../loop.js";
import {
  createDelivery,
  type Attachment,
  type DeliveryTarget,
} from "./delivery.js";
import {
  createFrame,
  loadRecords,
  watchLease,
  type ExecutionContext,
  type ExecutionFrame,
  type ExecutionRequest,
} from "./frame.js";
import { eventContext } from "./hooks.js";
import { Suspension } from "./interrupt.js";
import { prepareResume, prepareRecovery, restoreFrame } from "./resume.js";
import { recoverTools } from "./tool-executor.js";
import {
  bindSignals,
  detachSignals,
  attachSignals,
  signalMessages,
} from "./signal-delivery.js";
import { immutable } from "../json.js";

export async function execute(
  execution: ExecutionContext,
  request: ExecutionRequest,
  sink: Attachment,
  registry: RegistryLease,
): Promise<unknown> {
  let frame: ExecutionFrame | undefined;
  let pendingLease: Lease | undefined;
  try {
    if (sink.controller.signal.aborted)
      fail("Cancelled", "Execution cancelled before admission");
    if (request.kind === "resume") {
      frame = await attachSignals(execution, request.threadId, () =>
        prepareResume(execution, request, sink, registry),
      );
      execution.active.set(frame.stream.id, frame);
      watchLease(execution, frame);
      sink.admitted();
      await execution.hook(frame, streamHooks.resumed, {
        checkpointId: frame.cp.id,
        interruptId: request.interruptId,
        reason: "response",
      });
      const cursor = frame.cp.execution!.handlerCursor;
      if (cursor?.eventId === streamHooks.before) {
        const result = await execution.hook(
          frame,
          streamHooks.before,
          cursor.payload as any,
        );
        if (result?.decision === "deny" || result?.decision === "stop") {
          await execution.finish(
            frame,
            "stopped",
            result.reason ?? "PolicyStopped",
          );
          return;
        }
      }
      if (cursor?.eventId === modelHooks.recover) {
        const result = await execution.hook(
          frame,
          modelHooks.recover,
          cursor.payload as any,
        );
        if (result?.decision !== "retry")
          fail("ProviderError", "Recovery policy declined retry");
        frame.cp.execution!.phase = "BeforeModel";
        await execution.commit(frame, "ExecutionTransition");
      }
      await loop(frame, execution);
      return;
    }
    if (request.kind === "recover") {
      frame = await attachSignals(execution, request.threadId, () =>
        prepareRecovery(execution, request, sink, registry),
      );
      execution.active.set(frame.stream.id, frame);
      watchLease(execution, frame);
      sink.admitted();
      if (frame.cp.execution?.pendingInterruptId) {
        const interrupt = await execution.runtime.backend.executions.get(
          "interrupts",
          frame.cp.execution.pendingInterruptId,
          { threadId: request.threadId },
        );
        await execution.hook(frame, streamHooks.suspended, {
          checkpointId: frame.cp.id,
          interrupt: interrupt!,
        });
        return;
      }
      await execution.hook(frame, streamHooks.resumed, {
        checkpointId: frame.cp.id,
        interruptId: null,
        reason: "recovery",
      });
      await loop(frame, execution);
      return;
    }
    const head = await execution.runtime.backend.threads.get(request.threadId);
    if (!head) fail("ThreadNotFound", "Thread not found");
    if (head.activeStreamId)
      fail("ThreadBusy", "Thread already has unfinished execution");
    const lease = await execution.runtime.backend.ownership.acquire({
      threadId: request.threadId,
      ownerToken: execution.ids.next("owner"),
      ttlMs: 30000,
    });
    pendingLease = lease;
    const cp = structuredClone(
      (await execution.runtime.backend.checkpoints.get(
        head.currentCheckpointId,
      ))!,
    );
    const streamId = request.id!,
      usage = aggregateUsage([]);
    if (await execution.runtime.backend.executions.get("streams", streamId))
      fail("RegistrationConflict", "Stream ID already exists: " + streamId);
    const stream: StreamRecord = {
      id: streamId,
      threadId: request.threadId,
      scope: head.scope,
      triggerMessageId: null,
      status: "running",
      stopReason: null,
      startedAt: execution.clock.now(),
      endedAt: null,
      durationMs: null,
      error: null,
      directUsage: usage,
      outputMessageIds: [],
    };
    const records = await loadRecords(execution, request.threadId);
    frame = createFrame(execution, {
      request,
      sink,
      registry,
      lease,
      cp,
      stream,
      records,
      admitted: false,
    });
    execution.put(frame, "streams", stream);
    sink.setId(streamId);
    execution.active.set(streamId, frame);
    watchLease(execution, frame);
    cp.execution = {
      timing: { completedActiveMs: 0, segmentOpen: true, complete: true },
      streamId,
      turnId: null,
      phase: "BeforeTurn",
      modelRef: request.model,
      ...(request.modelOptions ? { modelOptions: request.modelOptions } : {}),
      baseInstructions: execution.agent.getInstruction(),
      pendingToolExecutionIds: [],
      pendingInterruptId: null,
      handlerCursor: null,
      budgets: {
        turns: 0,
        modelAttempts: 0,
        toolCalls: 0,
        limits: { ...execution.agent.limits(), ...request.limits },
      },
      registryManifest: [
        ...registry.values.map((r) => ({
          pluginId: r.pluginId,
          kind: r.kind,
          id: r.id,
          version: r.version,
          pluginVersion: r.pluginVersion,
          configurationId: r.configurationId,
          requiredForContinuation: true,
        })),
        ...registry.handlers.map((r) => ({
          pluginId: r.pluginId,
          kind: "handler",
          id: r.id,
          version: r.version,
          pluginVersion: r.pluginVersion,
          configurationId: r.configurationId,
          requiredForContinuation: r.kind !== "notification",
        })),
      ],
    };
    bindExecutionModel(registry, cp.execution, request.adapter);
    bindSignals(execution, frame);
    const input = await execution.hook(frame, inputHooks.prepare, {
      messages: request.input,
    });
    if (input.rejected) throw errorFromInfo(input.rejected);
    const transientInput = request.initialSignal?.persist === false;
    if (transientInput)
      frame.signals!.transientInput = immutable(input.messages);
    for (const message of input.messages) {
      if (transientInput) {
        const value = await execution.prepareMessage(frame, message, false);
        frame.signals!.applied.push({
          after: cp.state.messages.at(-1)?.id ?? null,
          message: value,
        });
        continue;
      }
      cp.state = {
        ...cp.state,
        messages: [
          ...cp.state.messages,
          await execution.prepareMessage(frame, message),
        ],
      };
    }
    stream.triggerMessageId = transientInput
      ? null
      : (input.messages[0]?.id ?? null);
    await execution.commit(frame, "InputCommitted");
    sink.seedState({ messages: signalMessages(frame) });
    frame.admitted = true;
    bindSignals(execution, frame);
    sink.admitted();
    await execution.hook(frame, streamHooks.started, {
      modelRef: request.model,
      checkpointId: frame.cp.id,
      startedAt: stream.startedAt,
    });
    await execution.hook(frame, inputHooks.received, {
      messages: input.messages,
    });
    if (input.handled) {
      for (const message of input.handled.output)
        await execution.appendMessage(frame, message);
      await execution.finish(frame, "completed", null);
      if (!frame.stream.endedAt) await loop(frame, execution);
      return;
    }
    const before = await execution.hook(frame, streamHooks.before, {
      input: input.messages,
    });
    if (before?.decision === "deny" || before?.decision === "stop") {
      await execution.finish(
        frame,
        "stopped",
        before.reason ?? "PolicyStopped",
      );
      return;
    }
    await loop(frame, execution);
  } catch (error) {
    if (error instanceof Suspension) return;
    if (frame?.ownershipError)
      error = new TessarError("OwnershipLost", "Execution ownership was lost");
    const info = errorInfo(error);
    if (
      frame?.admitted &&
      info.source !== "storage" &&
      ![
        "StorageUnavailable",
        "CommitConflict",
        "OwnershipLost",
        "RecoveryRequired",
      ].includes(info.code)
    ) {
      try {
        await execution.finish(
          frame,
          sink.controller.signal.aborted ? "cancelled" : "failed",
          info.code,
          info,
        );
        return error;
      } catch (finalizeError) {
        error = finalizeError;
      }
    }
    const finalError = errorInfo(error);
    const context = {
      ...eventContext(execution, frame),
      timestamp: execution.clock.now(),
      streamId: sink.stream.id,
      threadId: request.threadId,
      handleId: sink.stream.handleId,
    };
    const payload = {
      target: "execution" as const,
      error: finalError,
      lastKnownCheckpointId: frame?.cp.id ?? null,
      persistedStatus: frame?.stream.status ?? null,
      startedAt: frame?.stream.startedAt,
      endedAt: frame?.stream.endedAt ?? null,
    };
    execution.runtime.report(finalError, context);
    await execution.runtime.hooks
      .dispatch(streamHooks.error, payload, context, registry)
      .catch((cause) => execution.runtime.report(errorInfo(cause), context));
    sink.emit(streamHooks.error, payload, context);
    sink.rejected(finalError);
    return error;
  } finally {
    if (frame) {
      if (
        ["completed", "failed", "stopped", "cancelled"].includes(
          frame.stream.status,
        ) ||
        !frame.admitted
      )
        execution.pendingModels.delete(frame.request.threadId);
      if (frame.heartbeat) clearInterval(frame.heartbeat);
      execution.active.delete(frame.stream.id);
      try {
        await detachSignals(frame, () =>
          execution.runtime.backend.ownership.release(frame!.lease),
        );
      } catch {
        /* recovery uses lease expiry */
      }
    } else if (pendingLease) {
      try {
        await execution.runtime.backend.ownership.release(pendingLease);
      } catch {
        /* lease expiry remains authoritative */
      }
    }
    await registry.release();
    sink.close();
  }
}

export async function cancel(
  execution: ExecutionContext,
  threadId: string,
  streamId: string,
  reason = "Cancelled",
  target: DeliveryTarget = { kind: "observer", observe: () => {} },
  context: Pick<ExecutionRequest, "session" | "thread"> = {},
): Promise<void> {
  const active = execution.active.get(streamId);
  if (active) {
    if (active.cp.threadId !== threadId)
      fail("InvalidTransition", "Execution belongs to a different thread");
    await execution.hook(active, streamHooks.cancel, { reason });
    active.sink.controller.abort(reason);
    return;
  }
  const registry = execution.runtime.hooks.capture(),
    sink = createDelivery(
      threadId,
      execution.ids,
      target,
      undefined,
      execution.runtime.report,
    );
  let frame: ExecutionFrame | undefined;
  try {
    frame = await attachSignals(execution, threadId, () =>
      restoreFrame(
        execution,
        { ...context, kind: "recover", threadId, streamId },
        sink,
        registry,
        false,
      ),
    );
    watchLease(execution, frame);
    if (frame.cp.execution?.pendingToolExecutionIds.length)
      await recoverTools(frame, execution, true);
    for (const interrupt of execution.rows<
      import("../state/schema.js").InterruptRecord
    >(frame, "interrupts"))
      if (interrupt.streamId === streamId && interrupt.status === "pending") {
        interrupt.status = "cancelled";
        interrupt.resolvedAt = execution.clock.now();
      }
    for (const attempt of execution.rows<ModelAttemptRecord>(
      frame,
      "model_attempts",
    ))
      if (attempt.streamId === streamId && attempt.status === "running") {
        attempt.status = "cancelled";
        attempt.endedAt = execution.clock.now();
      }
    await execution.hook(frame, streamHooks.cancel, { reason });
    await execution.finish(frame, "cancelled", reason);
    execution.pendingModels.delete(threadId);
  } finally {
    if (frame) {
      if (frame.heartbeat) clearInterval(frame.heartbeat);
      await detachSignals(frame, () =>
        execution.runtime.backend.ownership.release(frame!.lease),
      );
    }
    await registry.release();
    sink.close();
  }
}
