import type {
  AnyEvent,
  EventEnvelope,
  PayloadOf,
  ResultOf,
  ContextOf,
  HookOptions,
} from "../events/definition.js";
import type { InterruptionDefinition } from "../engine/interrupt.js";
import type { EffectDefinition } from "../engine/tracked-effects.js";
import type { Tool } from "../tools/tool.js";
import type { ModelProviderRegistration } from "../models/contract.js";
import type { StorageBackend } from "../state/storage-ports.js";
import type { RecordStore } from "../state/records.js";
import type { PluginStateDefinition } from "../state/plugin-state.js";
import type { PluginStateContext } from "../state/plugin-state.js";
import type { JsonValue } from "../json.js";
import type { Session } from "../session.js";
import type { Thread } from "../thread.js";
import type { Agent } from "../agent.js";
export type Disposer = () => void | Promise<void>;
/** Read access to capabilities captured for the current hook execution. */
export interface CapabilityRegistry {
  get<T = unknown>(kind: string, id: string): T | undefined;
  list<T = unknown>(kind: string): readonly T[];
}
/** Controls that do not wait for completion of the active execution. */
export type SessionHookHandle = Pick<
  Session,
  | "id"
  | "scope"
  | "model"
  | "thread"
  | "followUp"
  | "state"
  | "isIdle"
  | "isDisposed"
>;
export type ThreadHookHandle = Pick<
  Thread,
  | "id"
  | "scope"
  | "snapshot"
  | "getHistory"
  | "getCheckpoint"
  | "listCheckpoints"
  | "listInterrupts"
>;
export interface HookContext {
  readonly registry: CapabilityRegistry;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly session?: SessionHookHandle;
  readonly thread?: ThreadHookHandle;
  readonly [key: string]: unknown;
}
export interface SessionHookContext extends HookContext {
  readonly session: SessionHookHandle;
}
export interface ThreadHookContext extends HookContext {
  readonly thread: ThreadHookHandle;
}
/** Durable execution state available at lifecycle observations, without control services. */
export interface StateHookContext extends HookContext {
  readonly state: PluginStateContext;
}
export type EventHandler<D extends AnyEvent> = (
  event: EventEnvelope<PayloadOf<D>, D>,
  context: ContextOf<D>,
) => ResultOf<D> | void | Promise<ResultOf<D> | void>;
export interface PluginContext {
  /** Registers an Agent owned by this plugin; shutdown follows plugin disposal. */
  readonly agent: { register(agent: Agent): void };
  readonly effects: { register(definition: EffectDefinition): void };
  readonly interruptions: {
    register(definition: InterruptionDefinition): void;
  };
  readonly state: {
    define<T extends JsonValue>(
      definition: Omit<PluginStateDefinition<T>, "pluginId">,
    ): PluginStateDefinition<T>;
  };
  readonly storage: {
    register(backend: StorageBackend): void;
    /** Independent records on the selected backend; available after initialization. */
    readonly records: RecordStore;
  };
  readonly tools: { register(tool: Tool): void };
  readonly models: {
    register(provider: ModelProviderRegistration): void;
  };
  hook<D extends AnyEvent>(
    name: D,
    handler: EventHandler<D>,
    options?: HookOptions,
  ): Disposer;
  emit<D extends AnyEvent>(
    definition: D,
    payload: PayloadOf<D>,
  ): Promise<ResultOf<D>>;
  defer(disposer: Disposer): void;
  readonly registry: {
    register(kind: string, id: string, value: unknown, version?: number): void;
  };
}
/** Instance contract implemented by built-in and user-defined plugin classes. */
export interface Plugin {
  readonly id: string;
  readonly version?: number;
  readonly configurationId?: string;
  setup(tessar: PluginContext): void | Disposer | Promise<void | Disposer>;
}
