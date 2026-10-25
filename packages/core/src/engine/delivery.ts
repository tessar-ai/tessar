import { notifyObserver } from "../events/observer.js";
import {
  checkpoint as checkpointHooks,
  stream as streamHooks,
  stateChanged,
} from "../events/type.js";
import { StateView, type RuntimeState } from "../runtime-state.js";
import { fail, errorInfo, type ErrorInfo } from "../errors.js";
import { systemClock, type IdGenerator } from "../json.js";
import {
  EventEnvelope,
  type AnyEvent,
  type EventContext,
  type PayloadOf,
  type StreamEvent,
} from "../events/definition.js";

export interface Stream extends AsyncIterable<StreamEvent> {
  readonly id: string | null;
  readonly threadId: string;
  readonly handleId: string;
  abort(reason?: string): void;
}
export type DeliveryTarget =
  | { kind: "iterator" }
  | {
      kind: "observer";
      observe: (event: StreamEvent) => void;
      admitted?: (receipt: { streamId: string; threadId: string }) => void;
      rejected?: (error: ErrorInfo) => void;
      closed?: () => void;
    };
export interface Attachment {
  stream: Stream;
  controller: AbortController;
  setId(id: string): void;
  seedState(state: Partial<RuntimeState>): void;
  emit<N extends AnyEvent>(
    definition: N,
    payload: PayloadOf<N>,
    context: EventContext,
  ): void;
  close(): void;
  admitted(): void;
  rejected(error: ErrorInfo): void;
}
export function createDelivery(
  threadId: string,
  ids: IdGenerator,
  target: DeliveryTarget,
  external?: AbortSignal,
  diagnostics: (error: ErrorInfo, context?: EventContext) => void = () => {},
  limits = { maxEvents: 512, maxBytes: 4 * 1024 * 1024 },
  initialId?: string,
  changed: (state: RuntimeState, context: EventContext) => void = () => {},
  failed: (
    event: EventEnvelope<
      PayloadOf<typeof streamHooks.error>,
      typeof streamHooks.error
    >,
  ) => void = () => {},
): Attachment {
  const view = new StateView();
  const controller = new AbortController(),
    handleId = ids.next("handle");
  let id: string | null = initialId ?? null,
    closed = false,
    consumerEnded = false,
    iterated = false,
    bytes = 0,
    lastCheckpoint: string | null = null;
  const queue: { event: StreamEvent; bytes: number }[] = [],
    waiting: ((value: IteratorResult<StreamEvent>) => void)[] = [];
  const report = (error: ErrorInfo, context?: EventContext) => {
    try {
      diagnostics(error, context);
    } catch {
      /* diagnostics cannot control execution */
    }
  };
  const cancel = () => {
    if (!closed) controller.abort(external?.reason);
  };
  if (external?.aborted) cancel();
  else external?.addEventListener("abort", cancel, { once: true });
  const drain = () => {
    if (!queue.length && (closed || consumerEnded))
      for (const resolve of waiting.splice(0))
        resolve({ value: undefined, done: true });
  };
  const stream: Stream = {
    get id() {
      return id;
    },
    threadId,
    handleId,
    abort(reason) {
      if (!closed) controller.abort(reason);
    },
    [Symbol.asyncIterator]() {
      if (iterated || target.kind !== "iterator")
        fail(
          "ConsumerAlreadyAttached",
          "Only one iterator consumer is allowed",
        );
      iterated = true;
      return {
        next: () => {
          const item = queue.shift();
          if (item) {
            bytes -= item.bytes;
            return Promise.resolve({ value: item.event, done: false });
          }
          return closed || consumerEnded
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise((resolve) => waiting.push(resolve));
        },
        return: async () => {
          consumerEnded = true;
          queue.length = 0;
          bytes = 0;
          drain();
          return { value: undefined, done: true };
        },
      };
    },
  };
  const deliver = (event: StreamEvent) => {
    const context: EventContext = event;
    if (event.type === checkpointHooks.committed)
      lastCheckpoint = event.payload.checkpointId;
    if (target.kind === "observer") {
      notifyObserver((event) => target.observe(event), event, report);
      return;
    }
    if (consumerEnded) return;
    const resolve = waiting.shift();
    if (resolve) {
      resolve({ value: event, done: false });
      return;
    }
    const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (queue.length + 1 > limits.maxEvents || bytes + size > limits.maxBytes) {
      const error: ErrorInfo = {
        source: "tessar",
        name: "TessarError",
        code: "ConsumerTooSlow",
        message: "Stream consumer exceeded its buffer",
        retryable: false,
      };
      queue.length = 0;
      bytes = 0;
      consumerEnded = true;
      const failure = new EventEnvelope(
        streamHooks.error,
        {
          target: "consumer" as const,
          error,
          lastKnownCheckpointId: lastCheckpoint,
          persistedStatus: null,
        },
        { ...context, streamId: id, threadId, handleId },
      );
      try {
        failed(failure);
      } catch (cause) {
        report(errorInfo(cause), failure);
      }
      queue.push({
        event: failure,
        bytes: 0,
      });
      report(error, { ...context, streamId: id, threadId, handleId });
      return;
    }
    queue.push({ event, bytes: size });
    bytes += size;
  };
  return {
    stream,
    controller,
    seedState(state) {
      view.update(state);
    },
    setId(value) {
      id = value;
    },
    emit(definition, payload, context) {
      if (closed) return;
      const identity = {
        ...context,
        timestamp: context.timestamp ?? systemClock.now(),
        streamId: id,
        threadId,
        handleId,
      };
      const event = new EventEnvelope(
        definition,
        payload,
        identity,
      ) as StreamEvent;
      const state = view.consume(event);
      deliver(event);
      if (state) {
        deliver(new EventEnvelope(stateChanged, { state }, identity));
        changed(state, identity);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      external?.removeEventListener("abort", cancel);
      drain();
      if (target.kind === "observer") target.closed?.();
    },
    admitted() {
      if (id && target.kind === "observer")
        target.admitted?.({ streamId: id, threadId });
    },
    rejected(error) {
      if (target.kind === "observer") target.rejected?.(error);
    },
  };
}
