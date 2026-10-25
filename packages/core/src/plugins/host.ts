import { diagnostic as diagnosticHooks } from "../events/type.js";
import {
  TessarError,
  errorInfo,
  fail,
  requireId,
  type ErrorInfo,
} from "../errors.js";
import { dispatch } from "../events/dispatcher.js";
import { hookKinds, type OperationEvent } from "../events/type.js";
import type {
  AnyEvent,
  EventContext,
  PayloadOf,
  ResultOf,
  EventKind,
} from "../events/definition.js";
import type { HookContext, Plugin, PluginContext } from "./context.js";
import {
  RegistryLease,
  type PluginSlot,
  type ValueRegistration,
} from "./registry.js";
import { definePluginState } from "../state/plugin-state.js";
import { systemClock } from "../json.js";
import { guardStorage } from "../state/storage-errors.js";
export class PluginHost {
  private slots: PluginSlot[] = [];
  private definitions = new Map<string, { kind: EventKind; version: number }>(
    Object.entries(hookKinds).map(([name, kind]) => [
      name,
      { kind, version: 1 },
    ]),
  );
  private storageSealed = false;
  async authorize<D extends OperationEvent>(
    name: D,
    payload: PayloadOf<D>,
    context: Partial<HookContext> & EventContext,
  ): Promise<void> {
    const decision = await this.dispatch(name, payload, context);
    if (decision?.decision === "deny")
      fail(
        "OperationDenied",
        decision.reason ?? "Operation denied by plugin policy",
      );
  }
  sealStorage(): void {
    this.storageSealed = true;
  }
  kind(name: string): EventKind {
    return (
      this.definitions.get(name)?.kind ?? hookKinds[name] ?? "notification"
    );
  }
  private mutation: Promise<void> = Promise.resolve();
  private closed = false;
  private disposal?: Promise<void>;
  private readonly diagnostics: (
    error: ErrorInfo,
    context?: EventContext,
  ) => void;
  private readonly values: readonly ValueRegistration[];
  constructor(
    options: {
      diagnostics?: (error: ErrorInfo, context?: EventContext) => void;
      values?: readonly ValueRegistration[];
    } = {},
  ) {
    this.diagnostics = options.diagnostics ?? (() => {});
    this.values = options.values ?? [];
  }
  async initialize(plugins: readonly Plugin[]): Promise<void> {
    try {
      for (const plugin of plugins) await this.attach(plugin);
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }
  private serialize(action: () => Promise<void>): Promise<void> {
    const next = this.mutation.then(action);
    this.mutation = next.catch(() => {});
    return next;
  }
  attach(plugin: Plugin): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) fail("Disposed", "Plugin host is closed");
      requireId(plugin.id, "plugin id");
      if (this.slots.some((s) => !s.detached && s.plugin.id === plugin.id))
        fail("RegistrationConflict", "Plugin ID already attached");
      const slot: PluginSlot = {
        plugin,
        handlers: [],
        values: [],
        disposers: [],
        references: 0,
        detached: false,
        disposed: false,
      };
      const definitions = new Map(this.definitions);
      const register = (
        kind: string,
        id: string,
        value: unknown,
        version = 1,
        configurationId: string | null = plugin.configurationId ?? null,
      ) => {
        requireId(id);
        if (kind === "storage" && this.storageSealed)
          fail(
            "InvalidTransition",
            "Storage backend is fixed after initialization",
          );
        if (
          [
            ...this.values,
            ...this.slots.filter((s) => !s.detached).flatMap((s) => s.values),
            ...slot.values,
          ].some((v) => v.kind === kind && v.id === id)
        )
          fail("RegistrationConflict", "Capability already registered");
        slot.values.push({
          kind,
          id,
          value,
          version,
          pluginId: plugin.id,
          pluginVersion: plugin.version ?? 1,
          configurationId,
        });
      };
      const tessar: PluginContext = {
        registry: { register },
        agent: {
          register: (agent) => {
            register("agent", agent.id, agent);
            tessar.defer(() => agent.shutdown());
          },
        },
        effects: {
          register: (definition) => {
            const stateDefinition = definePluginState({
              pluginId: plugin.id,
              namespace: "$effect:" + definition.id,
              schemaVersion: 1,
              initial: {},
            });
            register(
              "state",
              plugin.id + ":" + stateDefinition.namespace,
              stateDefinition,
            );
            register(
              "effect",
              definition.id,
              { definition, pluginId: plugin.id, stateDefinition },
              definition.version,
            );
          },
        },
        interruptions: {
          register: (definition) =>
            register(
              "interruption",
              definition.id,
              { definition, pluginId: plugin.id },
              definition.version,
            ),
        },
        state: {
          define: (definition) => {
            const state = definePluginState({
              ...definition,
              pluginId: plugin.id,
            });
            register(
              "state",
              plugin.id + ":" + state.namespace,
              state,
              state.schemaVersion,
            );
            return state;
          },
        },
        tools: {
          register: (tool) =>
            register(
              "tool",
              tool.name,
              tool,
              1,
              plugin.configurationId === undefined
                ? tool.configurationId
                : JSON.stringify([
                    plugin.configurationId,
                    tool.configurationId,
                  ]),
            ),
        },
        models: {
          register: (provider) => register("provider", provider.id, provider),
        },
        storage: {
          register: (backend) => {
            const storage = guardStorage(backend);
            register("storage", "primary", storage);
            tessar.defer(() => storage.close());
          },
        },
        defer: (disposer) => {
          slot.disposers.push(disposer);
        },
        hook: (name, handler, options = {}) => {
          requireId(name, "event name");
          const prior = definitions.get(name),
            kind =
              options.kind ?? prior?.kind ?? hookKinds[name] ?? "notification",
            version = options.version ?? prior?.version ?? 1;
          if (!Number.isInteger(version) || version < 1)
            fail("InvalidConfiguration", "Invalid hook version");
          if (prior && (prior.kind !== kind || prior.version !== version))
            fail("RegistrationConflict", "Hook contract conflict");
          definitions.set(name, { kind, version });
          const registration = {
            name,
            kind,
            version,
            handler,
            pluginId: plugin.id,
            id: plugin.id + ":" + name + ":" + slot.handlers.length,
            pluginVersion: plugin.version ?? 1,
            configurationId: plugin.configurationId ?? null,
          };
          slot.handlers.push(registration);
          return () => {
            const index = slot.handlers.indexOf(registration);
            if (index >= 0) slot.handlers.splice(index, 1);
          };
        },
        emit: (definition, payload) => this.dispatch(definition, payload),
      };
      try {
        const disposer = await plugin.setup(tessar);
        if (disposer) slot.disposers.push(disposer);
        this.slots.push(slot);
        this.definitions = definitions;
      } catch (error) {
        this.diagnostics(
          errorInfo(
            error,
            error instanceof TessarError
              ? undefined
              : { source: "plugin", pluginId: plugin.id },
          ),
        );
        slot.detached = true;
        await this.releaseSlot(slot);
        throw error;
      }
    });
  }
  detach(id: string): Promise<void> {
    return this.serialize(async () => {
      const slot = this.slots.find((s) => s.plugin.id === id && !s.detached);
      if (!slot) return;
      slot.detached = true;
      await this.releaseSlot(slot);
    });
  }
  private async releaseSlot(slot: PluginSlot): Promise<void> {
    if (!slot.detached || slot.references || slot.disposed) return;
    slot.disposed = true;
    for (const dispose of slot.disposers.slice().reverse()) {
      try {
        await dispose();
      } catch (error) {
        this.diagnostics(
          errorInfo(error, { source: "plugin", pluginId: slot.plugin.id }),
        );
      }
    }
  }
  capture(): RegistryLease {
    return new RegistryLease(
      this.slots.filter((s) => !s.detached),
      (slot) => this.releaseSlot(slot),
      this.values,
    );
  }
  async dispatch<D extends AnyEvent>(
    definition: D,
    payload: PayloadOf<D>,
    context: Partial<HookContext> & EventContext = {},
    captured?: RegistryLease,
  ): Promise<ResultOf<D>> {
    context = { ...context, timestamp: context.timestamp ?? systemClock.now() };
    const lease = captured ?? this.capture();
    try {
      return await dispatch(
        lease,
        definition,
        payload,
        context,
        definition === diagnosticHooks ? () => {} : this.diagnostics,
        this.kind(definition),
      );
    } catch (error) {
      if (definition !== diagnosticHooks)
        this.diagnostics(errorInfo(error), context);
      throw error;
    } finally {
      if (!captured) await lease.release();
    }
  }
  registrations(): readonly ValueRegistration[] {
    return [
      ...this.values,
      ...this.slots.filter((s) => !s.detached).flatMap((s) => s.values),
    ];
  }
  dispose(): Promise<void> {
    this.closed = true;
    return (this.disposal ??= this.serialize(async () => {
      for (const slot of this.slots.slice().reverse()) {
        slot.detached = true;
        await this.releaseSlot(slot);
      }
    }));
  }
}
