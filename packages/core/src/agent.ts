import { stream as streamHooks, stateChanged } from "./events/type.js";
import type { Controller } from "./controller.js";
import type { Model } from "./models/profile.js";
import type {
  ModelAdapter,
  ModelOptions,
  ModelRef,
} from "./models/contract.js";
import type { Scope, InterruptRecord, StreamLimits } from "./state/schema.js";
import type { StreamRecord } from "./trace/records.js";
import type { StorageBackend } from "./state/storage-ports.js";
import type { PluginHost } from "./plugins/host.js";
import {
  createDelivery,
  type Stream,
  type DeliveryTarget,
} from "./engine/delivery.js";
export type { Stream, DeliveryTarget } from "./engine/delivery.js";
import {
  errorInfo,
  errorFromInfo,
  fail,
  requireId,
  type ErrorInfo,
} from "./errors.js";
import {
  immutable,
  randomIds,
  systemClock,
  type Clock,
  type IdGenerator,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import {
  normalizeInstruction,
  type Instruction,
} from "./instructions/instruction.js";

import type { MessageData } from "./messages/message.js";
import { Tool } from "./tools/tool.js";
import { execute, cancel } from "./engine/execution.js";
import type {
  ExecutionContext,
  ExecutionFrame,
  ExecutionRequest,
} from "./engine/frame.js";
export type { ExecutionFrame, ExecutionRequest } from "./engine/frame.js";
import { hook } from "./engine/hooks.js";
import {
  put,
  rows,
  commit,
  updateUsage,
  prepareMessage,
  appendMessage,
  finish,
} from "./engine/checkpoint.js";
import { services } from "./engine/services.js";
import { callAgent, modelRef, readOutcome } from "./engine/call.js";
import type { ExecutionRuntime } from "./engine/runtime.js";
import { isModelAdapter } from "./models/stream.js";
import { reserveId } from "./identity.js";
import { createSignalMessage, type SendSignalOptions } from "./signal.js";
import {
  reserveSignals,
  releaseSignals,
  findSignalTarget,
  retainedSignals,
  deliverSignal,
  clearSignals,
} from "./engine/signal-delivery.js";
import {
  resumeAgent,
  cancelRetained,
  closeStandalone,
} from "./engine/continuation.js";

export type ModelSelection = ModelAdapter | Model | ModelRef;
export type AgentInput = string | MessageData | readonly MessageData[];
export interface AgentOptions<M extends ModelSelection = ModelSelection> {
  id: string;
  model: M;
  instructions?: string | Instruction;
  limits?: Partial<StreamLimits>;
  tools?: AgentTools;
}
export interface AgentTools {
  concurrency?: number;
  readonly [alias: string]: Tool | number | undefined;
}
export interface AgentExecutionOptions<M = ModelAdapter> {
  model?: M | Model | ModelRef | string;
  modelOptions?: ModelOptions<M>;
  scope?: Scope;
  context?: JsonObject;
  signal?: AbortSignal;
  limits?: Partial<StreamLimits>;
}
export interface AgentStreamOptions<
  M = ModelAdapter,
> extends AgentExecutionOptions<M> {
  id?: string;
}
export interface GenerateOutcome {
  threadId: string;
  streamId: string;
  status: StreamRecord["status"];
  output: readonly MessageData[];
  usage: import("./trace/usage.js").UsageSummary;
  interrupt: InterruptRecord | null;
  error: ErrorInfo | null;
}
export interface AgentResumeOptions {
  threadId: string;
  interruptId: string;
  value: JsonValue;
  scope?: Scope;
  signal?: AbortSignal;
}
function validateLimits(limits: Partial<StreamLimits>): void {
  for (const value of Object.values(limits))
    if (!Number.isInteger(value) || value < 1)
      fail("InvalidConfiguration", "Limits must be positive integers");
}
export class Agent<M extends ModelSelection = ModelSelection> {
  readonly id: string;
  private readonly tools: readonly Tool[];
  /** @internal */ readonly toolConcurrency: number;
  private readonly model: M;
  private controller?: Controller;
  /** @internal */ attachController(controller: Controller): void {
    if (this.controller)
      fail("AgentAlreadyBound", "Agent already belongs to a Controller");
    this.controller = controller;
  }
  private runtime(): Controller {
    if (!this.controller)
      fail("ControllerNotReady", "Initialize a Controller for this Agent");
    return this.controller;
  }
  /** @internal */ get backend(): StorageBackend {
    return this.runtime().backend;
  }
  /** @internal */ get registry(): PluginHost {
    return this.runtime().hooks;
  }
  /** @internal */ readonly ids: IdGenerator;
  /** @internal */ readonly clock: Clock;
  private readonly configuredLimits: StreamLimits;
  private readonly instructions: Instruction;
  private readonly jobs = new Set<Promise<void>>();
  private readonly outcomes = new WeakMap<Stream, Promise<GenerateOutcome>>();
  private readonly active = new Map<string, ExecutionFrame>();
  private readonly reservedStreamIds = new Set<string>();
  private readonly pendingModels = new Map<string, ModelAdapter>();
  private closed = false;
  private readonly releaseId: () => void;
  private readonly resumeAdmissions = new Map<
    string,
    Promise<ExecutionFrame>
  >();
  constructor(options: AgentOptions<M>) {
    this.id = requireId(options.id, "agent id");
    if (!options.model) fail("MissingModel", "Agent requires a default model");
    const { concurrency, ...tools } = options.tools ?? {};
    if (
      concurrency !== undefined &&
      (!Number.isInteger(concurrency) || concurrency < 1)
    )
      fail(
        "InvalidConfiguration",
        "Tool concurrency must be a positive integer",
      );
    const values = Object.values(tools);
    if (values.some((tool) => !(tool instanceof Tool)))
      fail("InvalidConfiguration", "Agent tools must be Tool instances");
    this.tools = Object.freeze(
      Object.entries(tools).map(([name, tool]) => {
        requireId(name, "tool alias");
        const value = tool as Tool;
        return name === value.name ? value : new Tool({ ...value, name });
      }),
    );
    if (new Set(this.tools.map((tool) => tool.name)).size !== this.tools.length)
      fail("RegistrationConflict", "Tool name already registered");
    this.toolConcurrency = concurrency ?? Infinity;
    this.model = (
      "ref" in options.model ? options.model : immutable(options.model)
    ) as M;
    const ref = modelRef(this.model);
    requireId(ref.providerId, "provider id");
    requireId(ref.modelId, "model id");
    this.ids = randomIds;
    this.clock = systemClock;
    this.instructions = normalizeInstruction(options.instructions);
    this.configuredLimits = immutable({
      maxTurns: 32,
      maxModelAttempts: 64,
      maxToolCalls: 128,
      ...options.limits,
    });
    validateLimits(this.configuredLimits);
    this.releaseId = reserveId("Agent", this.id, this);
  }
  /** Tools configured on this Agent, before execution-time plugin selection. */
  listTool(): readonly Tool[] {
    return this.tools;
  }
  /** Default model; per-execution overrides do not change this selection. */
  getModel(): M {
    return this.model;
  }
  /** Base instructions, before execution-time hook transformations. */
  getInstruction(): Instruction {
    return this.instructions;
  }
  /** Configured loop limits, including defaults; execution overrides are separate. */
  limits(): StreamLimits {
    return this.configuredLimits;
  }
  stream<T extends ModelAdapter = M extends ModelAdapter ? M : ModelAdapter>(
    input: AgentInput,
    options: AgentStreamOptions<T> = {},
  ): Stream {
    return callAgent(this, input, options, this.controller);
  }
  async generate<
    T extends ModelAdapter = M extends ModelAdapter ? M : ModelAdapter,
  >(
    input: AgentInput,
    options: AgentExecutionOptions<T> = {},
  ): Promise<GenerateOutcome> {
    const stream = this.stream(input, options);
    for await (const event of stream)
      if (event.type === streamHooks.error)
        throw errorFromInfo(event.payload.error);
    return this.outcomes.get(stream)!;
  }
  resume(options: AgentResumeOptions): Stream {
    if (this.closed) fail("Disposed", "Agent closed");
    return resumeAgent(this, options, this.controller);
  }
  async sendSignal(options: SendSignalOptions): Promise<void> {
    if (this.closed) fail("Disposed", "Agent closed");
    const message = createSignalMessage(options);
    const persist = options.persist ?? true;
    const box = findSignalTarget(this, options);
    if (options.threadId !== undefined) {
      if (!this.controller)
        fail(
          "ThreadNotSelected",
          "Thread signal targets require a live Session",
        );
      const controller = this.controller;
      const session = controller.signalSession(
        options.threadId,
        box?.frame?.request.session,
      );
      return session.receiveSignal(
        options.threadId,
        message,
        persist,
        async () => {
          let current = findSignalTarget(this, options);
          if (current && !current.accepting) return false;
          if (!current) {
            const head = await controller.queries.requireThread(
              options.threadId!,
              { scope: session.scope() },
            );
            if (!head.activeStreamId) return false;
            const cp = await controller.backend.checkpoints.get(
              head.currentCheckpointId,
            );
            if (!cp?.execution?.pendingInterruptId)
              fail(
                "RecoveryRequired",
                "Recover Thread before delivering signal",
              );
            current = retainedSignals(
              this,
              head.activeStreamId,
              head.id,
              controller,
            );
          }
          deliverSignal(
            this.executionContext(current.runtime),
            current,
            message,
            persist,
          );
          return true;
        },
      );
    }
    if (!box) fail("StreamNotFound", "Signal target is not active");
    deliverSignal(this.executionContext(box.runtime), box, message, persist);
  }
  /** @internal Shared admission for Thread, Session and testing. */
  admit(
    request: ExecutionRequest,
    target: DeliveryTarget = { kind: "iterator" },
    prepare?: () => Promise<void>,
    runtime?: ExecutionRuntime,
    cleanup?: (outcome?: GenerateOutcome) => Promise<void>,
    admitted?: () => void,
  ): Stream {
    const environment = runtime ?? this.runtime();
    if (environment === this.controller) this.controller!.requireReady();
    if (this.closed) fail("Disposed", "Agent closed");
    if (request.kind === "input")
      validateLimits({ ...this.configuredLimits, ...request.limits });
    const id =
      request.kind === "input"
        ? requireId(request.id ?? this.ids.next("stream"), "stream id")
        : request.kind === "recover"
          ? request.streamId
          : undefined;
    if (request.kind === "input") {
      if (this.reservedStreamIds.has(id!) || this.active.has(id!))
        fail("RegistrationConflict", "Stream ID already in use: " + id);
      request = { ...request, id };
    }
    if (
      !request.adapter &&
      isModelAdapter(this.model) &&
      request.model?.providerId === this.model.ref.providerId &&
      request.model.connectionId === this.model.ref.connectionId
    ) {
      request = {
        ...request,
        adapter:
          request.model.modelId === this.model.ref.modelId
            ? this.model
            : this.model.withModel?.(request.model.modelId),
      };
    }
    const sink = createDelivery(
      request.threadId,
      this.ids,
      target,
      request.signal,
      environment.report,
      undefined,
      id,
      (state, context) => {
        const session = request.session;
        void environment.hooks
          .dispatch(
            stateChanged,
            { state: session?.state.get() ?? state },
            { ...context, ...(session ? { session } : {}) },
          )
          .catch((error) => environment.report(errorInfo(error), context));
      },
      (event) => {
        const release = registry.retain();
        void environment.hooks
          .dispatch(streamHooks.error, event.payload, { ...event }, registry)
          .finally(release)
          .catch((error) => environment.report(errorInfo(error), event));
      },
    );
    const registry = environment.hooks.capture();
    if (request.kind === "input") this.reservedStreamIds.add(id!);
    reserveSignals(this, request, environment);
    if (admitted) {
      const notify = sink.admitted;
      sink.admitted = () => {
        admitted();
        notify();
      };
    }
    const outcome = (async () => {
      let entered = false;
      let result: GenerateOutcome | undefined;
      try {
        await prepare?.();
        if (this.closed) fail("Disposed", "Agent closed");
        entered = true;
        const failure = await execute(
          this.executionContext(environment),
          request,
          sink,
          registry,
        );
        if (failure !== undefined && errorInfo(failure).source === "provider")
          throw failure;
        result = await readOutcome(environment, sink.stream);
        return result;
      } catch (error) {
        environment.report(errorInfo(error));
        const context = {
          controllerId: environment.id,
          agentId: this.id,
          threadId: request.threadId,
          streamId: sink.stream.id,
          handleId: sink.stream.handleId,
          timestamp: this.clock.now(),
        };
        const payload = {
          target: "execution" as const,
          error: errorInfo(error),
          lastKnownCheckpointId: null,
          persistedStatus: null,
        };
        if (!entered) {
          await environment.hooks
            .dispatch(streamHooks.error, payload, context, registry)
            .catch((cause) => environment.report(errorInfo(cause), context));
          await registry.release();
        }
        sink.emit(streamHooks.error, payload, context);
        sink.rejected(errorInfo(error));
        sink.close();
        throw error;
      } finally {
        if (sink.stream.id && (request.kind === "input" || result))
          releaseSignals(this, sink.stream.id, result);
        if (
          (request.kind === "input" || result) &&
          result?.status !== "suspended" &&
          sink.stream.id
        )
          this.reservedStreamIds.delete(sink.stream.id);
        await cleanup?.(result);
      }
    })();
    this.outcomes.set(sink.stream, outcome);
    const job = outcome.then(
      () => {},
      () => {},
    );
    this.jobs.add(job);
    void job.then(() => this.jobs.delete(job));
    return sink.stream;
  }
  private executionContext(
    runtime: ExecutionRuntime = this.runtime(),
  ): ExecutionContext {
    const execution: ExecutionContext = {
      agent: this,
      runtime,
      active: this.active,
      pendingModels: this.pendingModels,
      resumeAdmissions: this.resumeAdmissions,
      ids: this.ids,
      clock: this.clock,
      toolConcurrency: this.toolConcurrency,
      hook: (frame, definition, payload, toolExecutionId) =>
        hook(execution, frame, definition, payload, toolExecutionId),
      put,
      rows,
      commit: (frame, cause, change) => commit(execution, frame, cause, change),
      updateUsage: (frame) => updateUsage(execution, frame),
      prepareMessage: (frame, message, persisted) =>
        prepareMessage(execution, frame, message, persisted),
      appendMessage: (frame, message) =>
        appendMessage(execution, frame, message),
      services: (frame, toolExecutionId) =>
        services(execution, frame, toolExecutionId),
      finish: (frame, status, reason, error) =>
        finish(execution, frame, status, reason, error),
    };
    return execution;
  }
  /** @internal */ async cancel(
    threadId: string,
    streamId: string,
    reason = "Cancelled",
    target: DeliveryTarget = { kind: "observer", observe: () => {} },
    context: Pick<ExecutionRequest, "session" | "thread"> = {},
  ): Promise<void> {
    return cancelRetained(this, threadId, reason, (runtime) =>
      cancel(
        this.executionContext(runtime ?? this.runtime()),
        threadId,
        streamId,
        reason,
        target,
        context,
      ),
    ).then(() => {
      this.reservedStreamIds.delete(streamId);
      releaseSignals(this, streamId, { status: "cancelled" });
    });
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const frame of this.active.values())
      frame.sink.controller.abort("Controller disposed");
    await Promise.allSettled([...this.jobs]);
    await clearSignals(this);
    await closeStandalone(this);
    this.pendingModels.clear();
    this.releaseId();
  }
}
