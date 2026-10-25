import { getThread } from "./state/thread-operations.js";
import {
  diagnostic as diagnosticHooks,
  ready as readyHooks,
  shutdown as shutdownHooks,
} from "./events/type.js";
import {
  requireId,
  fail,
  errorInfo,
  TessarError,
  type ErrorInfo,
} from "./errors.js";
import { immutable, randomIds } from "./json.js";
import { normalizeScope } from "./state/scope.js";
import { snapshotModelOptions } from "./models/options.js";
import type { StoredModelSelection, SessionRecord } from "./state/schema.js";

import { EventEnvelope, type EventContext } from "./events/definition.js";
import { PluginHost } from "./plugins/host.js";
import type { Plugin } from "./plugins/context.js";
import type { Agent, ModelSelection } from "./agent.js";
import type { Model } from "./models/profile.js";
import type { ModelProviderRegistration } from "./models/contract.js";
import { ModelRegistry } from "./models/registry.js";
import { createMemoryBackend } from "./state/memory-backend.js";
import { guardStorage } from "./state/storage-errors.js";
import type { StorageBackend } from "./state/storage-ports.js";
import { StateQueries } from "./state/queries.js";
import type { PageOptions, StateQuery } from "./state/schema.js";
import { canonicalJson } from "./state/commit.js";
import { Session, type SessionOptions } from "./session.js";
import { isModelAdapter } from "./models/stream.js";
import { toolRegistrations } from "./engine/runtime.js";
import { reserveId } from "./identity.js";

export class Controller {
  private readonly liveSessions = new Set<Session>();
  /** @internal */ forgetSession(session: Session): void {
    this.liveSessions.delete(session);
  }
  /** @internal */ signalSession(
    threadId: string,
    owner?: { id: string },
  ): Session {
    this.requireReady();
    const sessions = [...this.liveSessions].filter((session) =>
      session.selectsSignalThread(threadId),
    );
    const owned = sessions.find((session) => session === owner);
    if (owned) return owned;
    if (sessions.length > 1)
      fail("SessionBusy", "Multiple live Sessions select signal Thread");
    if (!sessions[0])
      fail(
        "ThreadNotSelected",
        "Select the signal Thread in a live Session first",
      );
    return sessions[0];
  }
  readonly id: string;
  readonly agent: Agent;
  private readonly modelRegistry = new ModelRegistry();
  /** @internal */ readonly diagnostics: ErrorInfo[] = [];
  /** @internal */ readonly report = (
    error: ErrorInfo,
    context: EventContext = {},
  ): void => {
    this.diagnostics.push(error);
    // Copy only event identity, never execution services from the failing hook.
    const event = new EventEnvelope(
      diagnosticHooks,
      { error },
      {
        ...context,
        controllerId: this.id,
        agentId: this.agent.id,
      },
    );
    void this.hooks
      .dispatch(diagnosticHooks, event.payload, { ...event })
      .catch(() => {});
  };
  /** @internal */ readonly hooks: PluginHost;
  /** @internal */ backend!: StorageBackend;
  /** @internal */ queries!: StateQueries;
  private phase:
    | "new"
    | "initializing"
    | "ready"
    | "failed"
    | "closing"
    | "closed" = "new";
  private initialization?: Promise<void>;
  private readonly initialPlugins: readonly Plugin[];
  private disposal?: Promise<void>;
  private readonly releaseId: () => void;
  private defaultBackend = false;
  private readonly providers = new Map<ModelProviderRegistration, () => void>();
  readonly plugins = {
    attach: async (plugin: Plugin): Promise<void> => {
      this.requireReady();
      await this.hooks.attach(plugin);
      this.syncProviders();
    },
    detach: async (id: string): Promise<void> => {
      this.requireReady();
      if (
        this.hooks
          .registrations()
          .some((r) => r.kind === "storage" && r.pluginId === id)
      )
        fail(
          "InvalidTransition",
          "Storage backend cannot be detached while ready",
        );
      await this.hooks.detach(id);
      this.syncProviders();
    },
  };
  constructor(options: {
    id: string;
    agent: Agent;
    plugins?: readonly Plugin[];
  }) {
    this.id = requireId(options.id, "controller id");
    this.agent = options.agent;
    const model = this.agent.getModel();
    this.hooks = new PluginHost({
      diagnostics: this.report,
      values: [
        {
          kind: "agent",
          id: this.agent.id,
          value: this.agent,
          version: 1,
          pluginId: this.agent.id,
          pluginVersion: 1,
          configurationId: null,
        },
        ...toolRegistrations(this.agent.id, this.agent.listTool()),
        ...(isModelAdapter(model)
          ? [
              {
                kind: "provider",
                id: model.ref.providerId,
                version: 1,
                pluginId: this.agent.id,
                pluginVersion: 1,
                configurationId: model.ref.connectionId ?? null,
                value: {
                  id: model.ref.providerId,
                  create: (modelId: string) => {
                    const model = this.agent.getModel();
                    if (!isModelAdapter(model))
                      fail("MissingProvider", "Executable model is missing");
                    if (model.ref.modelId === modelId) return model;
                    if (model.withModel) return model.withModel(modelId);
                    fail(
                      "UnsupportedModelSelection",
                      "This adapter cannot select another model ID",
                    );
                  },
                } satisfies ModelProviderRegistration,
              },
            ]
          : []),
      ],
    });
    this.initialPlugins = Object.freeze([...(options.plugins ?? [])]);
    this.releaseId = reserveId("Controller", this.id, this);
    try {
      this.agent.attachController(this);
    } catch (error) {
      this.releaseId();
      throw error;
    }
  }
  initialize(): Promise<void> {
    if (this.disposal)
      return Promise.reject(
        new TessarError("Disposed", "Controller is disposed"),
      );
    if (this.initialization) return this.initialization;
    if (this.phase !== "new")
      return Promise.reject(new Error("Controller is disposed"));
    this.phase = "initializing";
    this.initialization = (async () => {
      try {
        await this.hooks.initialize(this.initialPlugins);
        const selected = this.hooks
          .registrations()
          .find((r) => r.kind === "storage");
        this.backend =
          (selected?.value as StorageBackend) ??
          guardStorage(createMemoryBackend());
        this.defaultBackend = !selected;
        this.queries = new StateQueries(this.backend);
        this.syncProviders();
        this.hooks.sealStorage();
        this.phase = "ready";
        await this.hooks.dispatch(
          readyHooks,
          { agentId: this.agent.id },
          { controllerId: this.id, agentId: this.agent.id },
        );
        if ([...this.providers.keys()].some((p) => p.metadata))
          void this.modelRegistry.refreshCatalog();
      } catch (error) {
        this.report(errorInfo(error));
        this.phase = "failed";
        this.modelRegistry.dispose();
        await this.hooks.dispose();
        if (this.defaultBackend) await this.backend?.close();
        throw error;
      }
    })();
    return this.initialization;
  }
  /** @internal */ requireReady(): void {
    if (this.disposal || this.phase !== "ready")
      fail(
        this.disposal || this.phase === "closed" || this.phase === "closing"
          ? "Disposed"
          : "ControllerNotReady",
        "Controller must be initialized and ready",
      );
  }
  private syncProviders(): void {
    const current = this.hooks
      .registrations()
      .filter((r) => r.kind === "provider")
      .map((r) => r.value as ModelProviderRegistration);
    for (const [provider, remove] of this.providers)
      if (!current.includes(provider)) {
        remove();
        this.providers.delete(provider);
      }
    for (const provider of current)
      if (!this.providers.has(provider))
        this.providers.set(
          provider,
          this.modelRegistry.registerProvider(provider),
        );
  }
  /** @internal */ resolveModel(value: ModelSelection | undefined): Model {
    this.requireReady();
    if (!value)
      fail(
        "MissingModel",
        "Select a model explicitly or configure an Agent default",
      );
    const ref = "ref" in value ? value.ref : value;
    requireId(ref.providerId, "provider id");
    requireId(ref.modelId, "model id");
    if (
      isModelAdapter(value) &&
      "profile" in value &&
      typeof value.profile === "function" &&
      "refreshProfile" in value &&
      typeof value.refreshProfile === "function"
    )
      return value as Model;
    return this.modelRegistry.get(ref);
  }
  /** @internal */ sessionModel(value: ModelSelection): {
    model: Model;
    stored: StoredModelSelection;
    adapter: import("./models/contract.js").ModelAdapter;
  } {
    const ref = "ref" in value ? value.ref : value;
    const adapter = isModelAdapter(value)
      ? value
      : this.modelRegistry.resolve(ref);
    this.modelRegistry.retain(adapter);
    const stored = immutable({
      ref: adapter.ref,
      ...(adapter.options
        ? { options: snapshotModelOptions(adapter.options) }
        : {}),
      ...(adapter.connection ? { connection: adapter.connection } : {}),
    });
    return { model: this.resolveModel(adapter), stored, adapter };
  }
  async createSession(options: SessionOptions = {}): Promise<Session> {
    this.requireReady();
    if (options.threadId !== undefined) {
      requireId(options.threadId, "thread id");
      if (await this.backend.threads.get(options.threadId))
        fail(
          "RegistrationConflict",
          "Thread ID already exists: " + options.threadId,
        );
    }
    const id = requireId(options.id ?? randomIds.next("session"), "session id");
    if (await this.backend.sessions.get(id))
      fail("RegistrationConflict", "Session ID already exists: " + id);
    const selected = this.sessionModel(options.model ?? this.agent.getModel()),
      now = this.agent.clock.now();
    const record: SessionRecord = immutable({
      id,
      agentId: this.agent.id,
      scope: normalizeScope(options.scope),
      metadata: options.metadata ?? {},
      selectedThreadId: null,
      selectedModel: selected.stored,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await this.backend.sessions.compareAndSet(record, 0);
    this.requireReady();
    const session = Session.create(
      this,
      record,
      selected.model,
      this.modelRegistry,
    );
    this.liveSessions.add(session);
    session.created();
    if (options.threadId !== undefined)
      await session.thread.create({ id: options.threadId });
    return session;
  }
  async getSession(
    id: string,
    query: StateQuery = {},
  ): Promise<Session | null> {
    this.requireReady();
    const record = await this.backend.sessions.get(id, query);
    if (!record) return null;
    if (record.agentId !== this.agent.id)
      fail("SessionAgentMismatch", "Session belongs to another Agent");
    const selected = this.sessionModel(record.selectedModel.ref);
    if (
      record.selectedModel.connection &&
      canonicalJson(record.selectedModel.connection) !==
        canonicalJson(selected.stored.connection ?? null)
    )
      fail("ModelContextIncompatible", "Session model connection changed");
    const thread = record.selectedThreadId
      ? await getThread(this, record.selectedThreadId, { scope: record.scope })
      : null;
    if (record.selectedThreadId && !thread)
      fail("ThreadNotFound", "Session selection is unavailable");
    this.requireReady();
    const session = Session.create(
      this,
      record,
      selected.model,
      this.modelRegistry,
      thread,
    );
    await session.restoreState();
    this.liveSessions.add(session);
    return session;
  }
  isReady(): boolean {
    return this.phase === "ready";
  }
  listSessions(query: StateQuery & PageOptions = {}) {
    this.requireReady();
    return this.backend.sessions.page({ ...query, agentId: this.agent.id });
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposal = (async () => {
      if (this.initialization) await this.initialization.catch(() => {});
      this.phase = "closing";
      const sessions = [...this.liveSessions].map((session) =>
        session.close(true),
      );
      try {
        await this.agent.shutdown();
        for (const result of await Promise.allSettled(sessions))
          if (result.status === "rejected")
            this.report(errorInfo(result.reason));
        await this.hooks.dispatch(
          shutdownHooks,
          {},
          { controllerId: this.id, agentId: this.agent.id },
        );
      } catch (error) {
        this.report(errorInfo(error));
      } finally {
        try {
          this.modelRegistry.dispose();
          await this.hooks.dispose();
          if (this.defaultBackend) await this.backend?.close();
        } finally {
          this.phase = "closed";
          this.liveSessions.clear();
          this.releaseId();
        }
      }
    })();
    return this.disposal;
  }
}
