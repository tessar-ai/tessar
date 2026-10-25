import { createHash } from "node:crypto";
import {
  ROOT_CONTEXT,
  diag,
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  RandomIdGenerator,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { EventContext, MessageData } from "@tessar/core";
import type {
  OpenTelemetryOptions,
  ObservationType,
  ObservationAttributes,
  ExecutionTrace,
  ThreadTraceState,
} from "./types.js";
import { observationAttributes } from "./attributes.js";

export function update(
  span: Span,
  type: ObservationType,
  attributes: ObservationAttributes,
): void {
  if (span.isRecording())
    span.setAttributes(observationAttributes(type, attributes));
}
export const time = (event: EventContext, recorded?: string | null) =>
  recorded || event.timestamp
    ? new Date(recorded ?? event.timestamp!)
    : undefined;
const hash = (seed: string) => createHash("sha256").update(seed).digest("hex");

/** Owns the instance-local tracer, span hierarchy and active execution state. */
export function createTracing(
  options: OpenTelemetryOptions,
  spanProcessors: SpanProcessor[],
) {
  const random = new RandomIdGenerator();
  let nextTraceId: string | undefined;
  const provider = new BasicTracerProvider({
    spanProcessors,
    resource: options.serviceName
      ? resourceFromAttributes({ "service.name": options.serviceName })
      : undefined,
    idGenerator: {
      generateSpanId: () => random.generateSpanId(),
      generateTraceId: () => nextTraceId ?? random.generateTraceId(),
    },
  });
  const tracer = provider.getTracer("@tessar/opentelemetry");
  const executions = new Map<string, ExecutionTrace>();
  const links = new Map<string, ThreadTraceState>();
  const starts = new WeakMap<Span, number>();

  const start = (
    name: string,
    type: ObservationType,
    event: EventContext,
    identity: Record<string, unknown>,
    parent?: Span,
    attributes: ObservationAttributes = {},
    startedAt?: string | null,
  ): Span => {
    const observed = time(event) ?? new Date();
    let startTime = time(event, startedAt) ?? observed;
    const parentStart = parent && starts.get(parent);
    // A resumed logical task can predate this segment. Its new observation
    // starts at this notification, never before its fresh parent root.
    if (parentStart !== undefined && startTime.getTime() < parentStart)
      startTime = new Date(Math.max(parentStart, observed.getTime()));
    const span = tracer.startSpan(
      name,
      {
        startTime,
        attributes: observationAttributes(type, {
          ...attributes,
          metadata: {
            ...identity,
            ...attributes.metadata,
            recordStartedAt: startedAt,
          },
        }),
      },
      parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT,
    );
    starts.set(span, startTime.getTime());
    if (event.sessionId) span.setAttribute("session.id", event.sessionId);
    if (event.threadId)
      span.setAttribute("gen_ai.conversation.id", event.threadId);
    if (event.agentId) span.setAttribute("gen_ai.agent.id", event.agentId);
    if (type === "tool") span.setAttribute("gen_ai.tool.name", name);
    span.setAttribute(
      "tessar.trace.name",
      options.traceName ??
        (event.sessionId
          ? `${event.agentId ?? "agent"} / ${event.threadId}`
          : (event.agentId ?? "agent")),
    );
    if (options.tags?.length)
      span.setAttribute("tessar.trace.tags", [...options.tags]);
    return span;
  };
  const end = (
    span: Span,
    event: EventContext,
    endedAt?: string | null,
  ): void => {
    const observed = time(event) ?? new Date();
    const started = starts.get(span) ?? observed.getTime();
    const recorded = time(event, endedAt) ?? observed;
    if (endedAt)
      span.setAttribute(
        "tessar.metadata.recordEndedAt",
        JSON.stringify(endedAt),
      );
    span.end(
      new Date(
        Math.max(
          started,
          recorded.getTime() < started
            ? observed.getTime()
            : recorded.getTime(),
        ),
      ),
    );
  };

  const begin = (
    event: EventContext,
    checkpointId?: string,
    startedAt?: string | null,
  ): ExecutionTrace | undefined => {
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
        checkpointId,
        scope: event.scope,
      }).filter(([, value]) => value !== undefined),
    );
    const link = links.get(event.streamId);
    // Each invocation or continuation segment owns a fresh, recording root.
    nextTraceId = hash(
      JSON.stringify([
        event.controllerId,
        event.agentId,
        event.threadId,
        event.streamId,
        checkpointId,
      ]),
    ).slice(0, 32);
    let root: Span;
    try {
      root = start(
        event.agentId ?? "agent",
        "agent",
        event,
        identity,
        undefined,
        { output: [] },
        startedAt,
      );
    } finally {
      nextTraceId = undefined;
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
      const span = start(
        number === undefined ? "turn" : `turn ${number}`,
        "span",
        state.currentTurn === id && state.turnStartedAt
          ? { ...event, timestamp: state.turnStartedAt }
          : event,
        {
          ...state.identity,
          turnId: id,
          ...(index === undefined ? {} : { index }),
          turnNumber: number,
        },
        state.root,
        { output: [] },
        state.turnStartedAt,
      );
      turn = { span, output: [] };
      state.turns.set(id, turn);
    }
    return turn.span;
  };
  const failure = (
    span: Span,
    type: ObservationType,
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
    endedAt?: string | null,
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
        end(span, event);
      }
    }
    if (error) failure(state.root, "agent", error);
    update(state.root, "agent", {
      // Stream outcomes include earlier suspended segments; this root owns
      // only the messages published during its current continuation.
      output: state.identity.checkpointId
        ? state.output
        : (output ?? state.output),
      metadata: { status },
      ...(status === "suspended" ||
      status === "cancelled" ||
      status === "interrupted"
        ? { level: "WARNING" as const }
        : {}),
    });
    end(state.root, event, endedAt);
    executions.delete(event.streamId!);
    links.delete(event.streamId!);
  };

  return {
    executions,
    links,
    start,
    end,
    begin,
    current,
    parentTurn,
    failure,
    finish,
    shutdown: () =>
      provider.shutdown().catch((error) => {
        diag.error("Tessar trace export shutdown failed", error);
      }),
  };
}

export type TraceRuntime = ReturnType<typeof createTracing>;
