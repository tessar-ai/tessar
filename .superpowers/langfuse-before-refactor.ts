import { createHash } from "node:crypto";
import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  RandomIdGenerator,
} from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  createObservationAttributes,
  type LangfuseObservationAttributes,
  type LangfuseObservationType,
} from "@langfuse/tracing";
import {
  stream,
  turn,
  model,
  tool,
  message,
  input,
  type EventContext,
  type Plugin,
  type PluginContext,
  type ModelUsage,
  type JsonObject,
  type MessageData,
} from "@tessar/core";

export interface LangfuseOptions {
  /** Defaults to LANGFUSE_PUBLIC_KEY through the Langfuse SDK. */
  publicKey?: string;
  /** Defaults to LANGFUSE_SECRET_KEY through the Langfuse SDK. */
  secretKey?: string;
  /** Cloud region or self-hosted URL; defaults to the Langfuse SDK's setting. */
  baseUrl?: string;
  /** Override the shared trace name; individual tool/model names are unchanged. */
  traceName?: string;
  /** Application-defined tags propagated to every observation. */
  tags?: readonly string[];
  /** Optional reference to an existing Langfuse prompt used by primary calls. */
  prompt?: { name: string; version: number };
}

interface TurnTrace {
  span: Span;
  output: MessageData[];
}
type ThreadTraceState = {
  rootCreated: boolean;
  turnCount: number;
  turnId: string;
  turnCreated: boolean;
};
interface TraceLink extends ThreadTraceState {
  rootNew: boolean;
  turnNew: boolean;
}
interface ExecutionTrace {
  root: Span;
  link?: TraceLink;
  turns: Map<string, TurnTrace>;
  output: MessageData[];
  models: Map<string, Span>;
  tools: Map<string, Span>;
  calls: Map<string, { name: string; arguments: JsonObject }>;
  firstOutputs: Set<string>;
  currentTurn?: string;
  identity: Record<string, unknown>;
}

// Langfuse flat usage details must contain exclusive, non-overlapping buckets.
function usageDetails(usage: ModelUsage): Record<string, number> | undefined {
  const details: Record<string, number> = {};
  const read = usage.cacheReadInputTokens,
    write = usage.cacheWriteInputTokens;
  if (usage.inputTokens !== null) {
    if ((read ?? 0) + (write ?? 0) <= usage.inputTokens) {
      details.input = usage.inputTokens - (read ?? 0) - (write ?? 0);
      if (read !== null) details.input_cached_tokens = read;
      if (write !== null) details.input_cache_write = write;
    } else details.input = usage.inputTokens;
  } else {
    if (read !== null) details.input_cached_tokens = read;
    if (write !== null) details.input_cache_write = write;
    if (usage.uncachedInputTokens !== null)
      details.input = usage.uncachedInputTokens;
  }
  if (usage.outputTokens !== null) {
    const reasoning = usage.reasoningOutputTokens;
    if (reasoning !== null && reasoning <= usage.outputTokens) {
      details.output = usage.outputTokens - reasoning;
      details.output_reasoning_tokens = reasoning;
    } else details.output = usage.outputTokens;
  } else if (usage.reasoningOutputTokens !== null) {
    details.output_reasoning_tokens = usage.reasoningOutputTokens;
  }
  if (usage.totalTokens !== null) details.total = usage.totalTokens;
  return Object.keys(details).length ? details : undefined;
}

function update(
  span: Span,
  type: LangfuseObservationType,
  attributes: LangfuseObservationAttributes,
): void {
  if (span.isRecording())
    span.setAttributes(createObservationAttributes(type, attributes));
}
const time = (event: EventContext) =>
  event.timestamp ? new Date(event.timestamp) : undefined;
const hash = (seed: string) => createHash("sha256").update(seed).digest("hex");

/** Optional Langfuse export using explicit parents and an instance-local tracer. */
export class LangfusePlugin implements Plugin {
  readonly id = "langfuse";
  readonly #options: LangfuseOptions;

  constructor(options: LangfuseOptions = {}) {
    this.#options = {
      ...options,
      tags: options.tags?.slice(),
      prompt: options.prompt ? { ...options.prompt } : undefined,
    };
  }

  setup(tessar: PluginContext): void {
    const random = new RandomIdGenerator();
    let nextTraceId: string | undefined;
    let nextSpanId: string | undefined;
    const provider = new BasicTracerProvider({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: this.#options.publicKey,
          secretKey: this.#options.secretKey,
          baseUrl: this.#options.baseUrl,
          shouldExportSpan: ({ otelSpan }) =>
            otelSpan.instrumentationScope.name === "@tessar/langfuse",
        }),
      ],
      idGenerator: {
        generateSpanId: () => nextSpanId ?? random.generateSpanId(),
        generateTraceId: () => nextTraceId ?? random.generateTraceId(),
      },
    });
    const tracer = provider.getTracer("@tessar/langfuse");
    const executions = new Map<string, ExecutionTrace>();
    const links = new Map<string, TraceLink>();
    const savedTrace = tessar.state.define<ThreadTraceState>({
      namespace: "trace",
      schemaVersion: 1,
      initial: {
        rootCreated: false,
        turnCount: 0,
        turnId: "",
        turnCreated: false,
      },
      fork: "reset",
    });
    const linkedSpan = (event: EventContext, spanId: string) =>
      trace.wrapSpanContext({
        traceId: hash(event.threadId!).slice(0, 32),
        spanId,
        traceFlags: 1,
      });

    tessar.hook(input.prepare, (event, context) => {
      if (!event.sessionId || !event.streamId) return;
      const saved = context.state.get(savedTrace);
      links.set(event.streamId, {
        ...saved,
        rootNew: !saved.rootCreated,
        turnNew: false,
      });
      if (!saved.rootCreated)
        context.state.update(savedTrace, { ...saved, rootCreated: true });
    });
    tessar.hook(model.select, (event, context) => {
      if (!event.sessionId || typeof context.turnId !== "string") return;
      const link = links.get(context.streamId);
      if (!link) return;
      const saved = context.state.get(savedTrace),
        fresh = saved.turnId !== context.turnId;
      const value = {
        ...saved,
        rootCreated: true,
        turnId: context.turnId,
        turnCount: saved.turnCount + (fresh ? 1 : 0),
        turnCreated: true,
      };
      context.state.update(savedTrace, value);
      Object.assign(link, value, { turnNew: fresh || !saved.turnCreated });
    });

    const start = (
      name: string,
      type: LangfuseObservationType,
      event: EventContext,
      identity: Record<string, unknown>,
      parent?: Span,
      attributes: LangfuseObservationAttributes = {},
      spanId?: string,
    ): Span => {
      nextSpanId = spanId;
      let span: Span;
      try {
        span = tracer.startSpan(
          name,
          {
            startTime: time(event),
            attributes: createObservationAttributes(type, {
              ...attributes,
              metadata: { ...identity, ...attributes.metadata },
            }),
          },
          parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT,
        );
      } finally {
        nextSpanId = undefined;
      }
      if (event.sessionId) span.setAttribute("session.id", event.sessionId);
      span.setAttribute(
        "langfuse.trace.name",
        this.#options.traceName ??
          (event.sessionId
            ? `${event.agentId ?? "agent"} / ${event.threadId}`
            : (event.agentId ?? "agent")),
      );
      if (this.#options.tags?.length)
        span.setAttribute("langfuse.trace.tags", [...this.#options.tags]);
      return span;
    };

    const begin = (event: EventContext): ExecutionTrace | undefined => {
      if (!event.streamId) return;
      const existing = executions.get(event.streamId);
      if (existing) return existing;
      const identity = Object.fromEntries(
        Object.entries({
          controllerId: event.controllerId,
          agentId: event.agentId,
          sessionId: event.sessionId,
          threadId: event.threadId,
          streamId: event.streamId,
          scope: event.scope,
        }).filter(([, value]) => value !== undefined),
      );
      const link = links.get(event.streamId);
      const rootId = hash(`root:${event.threadId}`).slice(0, 16);
      let root: Span;
      if (link && !link.rootNew) root = linkedSpan(event, rootId);
      else {
        // A Thread always derives the same IDs. Existing observations are not
        // exported again; future operations only refer to their parent context.
        nextTraceId = link
          ? hash(event.threadId!).slice(0, 32)
          : hash(
              JSON.stringify([
                event.controllerId,
                event.agentId,
                event.threadId,
                event.streamId,
              ]),
            ).slice(0, 32);
        try {
          root = start(
            event.agentId ?? "agent",
            "agent",
            event,
            identity,
            undefined,
            { output: [] },
            link ? rootId : undefined,
          );
        } finally {
          nextTraceId = undefined;
        }
      }
      const state: ExecutionTrace = {
        root,
        link,
        identity,
        output: [],
        turns: new Map(),
        models: new Map(),
        tools: new Map(),
        calls: new Map(),
        firstOutputs: new Set(),
      };
      executions.set(event.streamId, state);
      return state;
    };
    const current = (event: EventContext) =>
      event.streamId ? executions.get(event.streamId) : undefined;
    const parentTurn = (
      state: ExecutionTrace,
      event: EventContext,
      id = state.currentTurn,
      index?: number,
    ): Span => {
      if (!id) return state.root;
      let turn = state.turns.get(id);
      if (!turn) {
        let number = index === undefined ? undefined : index + 1;
        if (state.link?.turnId === id) number = state.link.turnCount;
        const spanId = hash(`turn:${event.threadId}:${id}`).slice(0, 16);
        const span =
          state.link?.turnId === id && !state.link.turnNew
            ? linkedSpan(event, spanId)
            : start(
                number === undefined ? "turn" : `turn ${number}`,
                "span",
                event,
                {
                  ...state.identity,
                  turnId: id,
                  ...(index === undefined ? {} : { index }),
                  turnNumber: number,
                },
                state.root,
                { output: [] },
                state.link ? spanId : undefined,
              );
        turn = { span, output: [] };
        state.turns.set(id, turn);
      }
      return turn.span;
    };
    const failure = (
      span: Span,
      type: LangfuseObservationType,
      error: { message: string },
    ): void => {
      if (!span.isRecording()) return;
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error.message);
      update(span, type, {
        level: "ERROR",
        statusMessage: error.message,
        metadata: { error },
      });
    };
    const finish = (
      event: EventContext,
      status: string,
      error?: { message: string } | null,
      output?: readonly MessageData[],
    ): void => {
      const state = current(event);
      if (!state) return;
      for (const [spans, type] of [
        [state.models, "generation"],
        [state.tools, "tool"],
        [[...state.turns.values()].map((turn) => turn.span), "span"],
      ] as const) {
        for (const span of spans.values()) {
          if (error) failure(span, type, error);
          update(span, type, {
            level: error ? "ERROR" : "WARNING",
            metadata: {
              status: status === "completed" ? "interrupted" : status,
            },
          });
          span.end(time(event));
        }
      }
      if (error) failure(state.root, "agent", error);
      update(state.root, "agent", {
        output: output ?? state.output,
        metadata: { status },
        ...(status === "suspended" ||
        status === "cancelled" ||
        status === "interrupted"
          ? { level: "WARNING" as const }
          : {}),
      });
      state.root.end(time(event));
      executions.delete(event.streamId!);
      links.delete(event.streamId!);
    };

    tessar.defer(async () => {
      for (const streamId of [...executions.keys()])
        finish({ streamId }, "interrupted");
      links.clear();
      await provider.shutdown();
    });
    tessar.hook(stream.started, (event) => {
      begin(event);
    });
    tessar.hook(stream.resumed, async (event, context) => {
      // A continued Turn does not emit turn.start again. Restore its identity
      // from the existing checkpoint, without reconstructing an unrecorded request.
      const checkpoint = await context.thread?.getCheckpoint(
        event.payload.checkpointId,
      );
      const snapshot = checkpoint?.state.pluginStates.find(
        (value) =>
          value.pluginId === "langfuse" &&
          value.namespace === "trace" &&
          value.ownerType === "thread",
      );
      if (event.sessionId && event.streamId && snapshot) {
        const saved = snapshot.data as unknown as ThreadTraceState;
        links.set(event.streamId, {
          ...saved,
          rootNew: !saved.rootCreated,
          turnNew: !saved.turnCreated,
        });
      }
      const state = begin(event);
      if (!state) return;
      update(state.root, "agent", {
        input: event.payload,
        metadata: { inputSource: "resume" },
      });
      if (!checkpoint) return;
      const execution = checkpoint.execution;
      if (!execution?.turnId || execution.phase === "BeforeTurn") return;
      state.currentTurn = execution.turnId;
      const span = parentTurn(
        state,
        event,
        execution.turnId,
        execution.budgets.turns - 1,
      );
      update(span, "span", {
        input: { messages: checkpoint.state.messages },
        metadata: { inputSource: "checkpoint" },
      });
      for (const message of checkpoint.state.messages)
        for (const part of message.content)
          if (part.type === "tool-call")
            state.calls.set(part.toolCallId, {
              name: part.name,
              arguments: part.arguments,
            });
    });
    tessar.hook(input.received, (event) => {
      const state = current(event);
      if (!state) return;
      update(state.root, "agent", { input: event.payload.messages });
    });
    tessar.hook(turn.start, (event) => {
      const state = current(event);
      if (!state) return;
      state.currentTurn = event.payload.turnId;
      // Thread numbering is checkpointed by model.select before model.start.
      if (!state.link)
        parentTurn(state, event, event.payload.turnId, event.payload.index);
    });
    tessar.hook(turn.end, (event) => {
      const state = current(event),
        turn = state?.turns.get(event.payload.turnId);
      if (!turn) return;
      update(turn.span, "span", {
        metadata: { usage: event.payload.usage, status: "ended" },
      });
      turn.span.end(time(event));
      state!.turns.delete(event.payload.turnId);
    });
    tessar.hook(message.committed, (event) => {
      const state = current(event),
        value = event.payload.message;
      if (!state || (value.role !== "assistant" && value.role !== "tool"))
        return;
      state.output.push(value);
      const turn = state.currentTurn
        ? state.turns.get(state.currentTurn)
        : undefined;
      if (turn) {
        turn.output.push(value);
        update(turn.span, "span", { output: turn.output });
      }
    });
    tessar.hook(model.start, (event) => {
      const state = current(event);
      if (!state || state.models.has(event.payload.attemptId)) return;
      const { attemptId, request, purpose, parentToolExecutionId, turnId } =
        event.payload;
      if (turnId) state.currentTurn = turnId;
      if (purpose !== "auxiliary" && request) {
        update(parentTurn(state, event, turnId), "span", {
          input: request,
          metadata: { inputSource: "model.request" },
        });
      }
      const parent = parentToolExecutionId
        ? state.tools.get(parentToolExecutionId)
        : undefined;
      const span = start(
        event.payload.model.modelId,
        "generation",
        event,
        {
          ...state.identity,
          attemptId,
          purpose,
          parentToolExecutionId,
          turnId,
          providerId: event.payload.model.providerId,
          options: request?.options,
        },
        parent ?? parentTurn(state, event, turnId),
        {
          model: event.payload.model.modelId,
          input: request,
          ...(purpose !== "auxiliary" && this.#options.prompt
            ? { prompt: { ...this.#options.prompt, isFallback: false } }
            : {}),
          modelParameters: Object.fromEntries(
            Object.entries(request?.options ?? {}).filter(
              ([, value]) =>
                typeof value === "string" || typeof value === "number",
            ),
          ) as Record<string, string | number>,
        },
      );
      state.models.set(attemptId, span);
    });
    tessar.hook(message.delta, (event) => {
      const state = current(event),
        span = state?.models.get(event.payload.attemptId);
      if (!span || state!.firstOutputs.has(event.payload.attemptId)) return;
      state!.firstOutputs.add(event.payload.attemptId);
      update(span, "generation", {
        completionStartTime: time(event) ?? new Date(),
      });
    });
    const recordUsage = (span: Span, usage: ModelUsage) =>
      update(span, "generation", {
        usageDetails: usageDetails(usage),
        metadata: { usage },
      });
    tessar.hook(model.usage, (event) => {
      const span = current(event)?.models.get(event.payload.attemptId);
      if (span) recordUsage(span, event.payload.usage);
    });
    tessar.hook(model.end, (event) => {
      const state = current(event),
        span = state?.models.get(event.payload.attemptId);
      if (!span) return;
      const { response } = event.payload;
      if (response.usage) recordUsage(span, response.usage);
      update(span, "generation", {
        output: response.message,
        metadata: {
          finishReason: response.finishReason,
          providerRequestId: response.providerRequestId,
        },
      });
      if (event.payload.purpose !== "auxiliary")
        for (const part of response.message.content)
          if (part.type === "tool-call")
            state!.calls.set(part.toolCallId, {
              name: part.name,
              arguments: part.arguments,
            });
      span.end(time(event));
      state!.models.delete(event.payload.attemptId);
      state!.firstOutputs.delete(event.payload.attemptId);
    });
    tessar.hook(model.error, (event) => {
      const state = current(event),
        span = state?.models.get(event.payload.attemptId);
      if (!span) return;
      failure(span, "generation", event.payload.error);
      span.end(time(event));
      state!.models.delete(event.payload.attemptId);
      state!.firstOutputs.delete(event.payload.attemptId);
    });
    tessar.hook(tool.start, (event) => {
      const state = current(event);
      if (!state || state.tools.has(event.payload.toolExecutionId)) return;
      const call = state.calls.get(event.payload.toolCallId);
      const span = start(
        event.payload.name ?? call?.name ?? "tool",
        "tool",
        event,
        {
          ...state.identity,
          toolExecutionId: event.payload.toolExecutionId,
          toolCallId: event.payload.toolCallId,
        },
        parentTurn(state, event, event.payload.turnId),
        { input: event.payload.arguments ?? call?.arguments },
      );
      state.tools.set(event.payload.toolExecutionId, span);
    });
    tessar.hook(tool.error, (event) => {
      const span = current(event)?.tools.get(event.payload.toolExecutionId);
      if (span) failure(span, "tool", event.payload.error);
    });
    tessar.hook(tool.end, (event) => {
      const state = current(event);
      if (!state) return;
      const call = state.calls.get(event.payload.toolCallId);
      const span =
        state.tools.get(event.payload.toolExecutionId) ??
        start(
          call?.name ?? "tool",
          "tool",
          event,
          {
            ...state.identity,
            toolExecutionId: event.payload.toolExecutionId,
            toolCallId: event.payload.toolCallId,
          },
          parentTurn(state, event),
          { input: call?.arguments },
        );
      update(span, "tool", {
        output: event.payload.result,
        metadata: { status: event.payload.status },
      });
      span.end(time(event));
      state.tools.delete(event.payload.toolExecutionId);
      state.calls.delete(event.payload.toolCallId);
    });
    tessar.hook(stream.suspended, (event) => {
      finish(event, "suspended");
    });
    tessar.hook(stream.end, (event) => {
      finish(
        event,
        event.payload.status,
        event.payload.error,
        event.payload.output,
      );
    });
    tessar.hook(stream.error, (event) => {
      begin(event);
      finish(
        event,
        event.payload.persistedStatus ?? "failed",
        event.payload.error,
      );
    });
  }
}
