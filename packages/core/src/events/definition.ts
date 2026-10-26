import { immutable, systemClock, type JsonObject } from "../json.js";
import type { HookContext } from "../plugins/context.js";
export type EventKind =
  | "notification"
  | "transformation"
  | "decision"
  | "barrier";
export interface HookSpec<P, R = void, C = HookContext> {
  payload: P;
  result: R;
  context: C;
}
/** Plugins may augment this compile-time map with their own event names. */
export interface EventMap {}
export type AnyEvent = keyof EventMap & string;
export type PayloadOf<N extends AnyEvent> = EventMap[N]["payload"];
export type ResultOf<N extends AnyEvent> = EventMap[N]["result"];
export type ContextOf<N extends AnyEvent> = EventMap[N]["context"];
export interface HookOptions {
  kind?: EventKind;
  version?: number;
}
export interface EventContext {
  controllerId?: string;
  agentId?: string;
  sessionId?: string;
  scope?: JsonObject;
  threadId?: string;
  streamId?: string | null;
  handleId?: string;
  sequence?: number;
  timestamp?: string;
  checkpointRevision?: number;
}
export class EventEnvelope<
  P = any,
  N extends string = string,
> implements EventContext {
  readonly controllerId?: string;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly scope?: JsonObject;
  readonly threadId?: string;
  readonly streamId?: string | null;
  readonly handleId?: string;
  readonly sequence?: number;
  readonly timestamp!: string;
  readonly checkpointRevision?: number;
  constructor(
    readonly type: N,
    readonly payload: P,
    context: EventContext = {},
  ) {
    context = { ...context, timestamp: context.timestamp ?? systemClock.now() };
    for (const key of [
      "controllerId",
      "agentId",
      "sessionId",
      "scope",
      "threadId",
      "streamId",
      "handleId",
      "sequence",
      "timestamp",
      "checkpointRevision",
    ] as const)
      if (context[key] !== undefined)
        Object.defineProperty(this, key, {
          value: key === "scope" ? immutable(context[key]) : context[key],
          enumerable: true,
        });
    Object.freeze(this);
  }
}
export type StreamEvent = {
  [N in AnyEvent]: EventEnvelope<PayloadOf<N>, N>;
}[AnyEvent];
