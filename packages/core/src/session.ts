import { notifyObserver } from "./events/observer.js";
import {
  session as sessionHooks,
  thread as threadHooks,
  stream as streamHooks,
  stateChanged,
} from "./events/type.js";
import { StateView, stateTool, type RuntimeState } from "./runtime-state.js";
import type { Controller } from "./controller.js";
import { Thread, type ThreadStreamOptions } from "./thread.js";

import {
  EventEnvelope,
  type AnyEvent,
  type PayloadOf,
  type StreamEvent,
  type EventContext,
} from "./events/definition.js";
import {
  type ExecutionReceipt,
  type QueuedInputReceipt,
} from "./events/type.js";
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
  type JsonValue,
  type JsonObject,
} from "./json.js";
import { inputMessages } from "./messages/codec.js";
import type { Model, ModelProfile } from "./models/profile.js";
import type { ModelRegistry } from "./models/registry.js";
import {
  snapshotModelOptions,
  validateModelOptions,
} from "./models/options.js";
import type { ModelRef } from "./models/contract.js";
import { HumanMessage, type MessageData } from "./messages/message.js";
import type { Scope, PageOptions, SessionRecord } from "./state/schema.js";
import { canonicalJson } from "./state/commit.js";
import type { CreateThreadOptions } from "./state/threads.js";
import type { ForkOptions } from "./state/fork.js";
import type { HistoryOptions } from "./state/queries.js";
import type { Stream } from "./engine/delivery.js";
import {
  createThread,
  getThread,
  listThreads,
  renameThread,
  forkThread,
  deleteThread,
  purgeThread,
} from "./state/thread-operations.js";
export interface SessionOptions {
  id?: string;
  scope?: Scope;
  model?: Model | ModelRef;
  metadata?: JsonObject;
  threadId?: string;
}
export type SessionThreadOptions = Pick<
  CreateThreadOptions,
  "id" | "title" | "messages" | "metadata"
>;
export interface SessionModelInfo {
  readonly id: string;
  readonly name: string;
  readonly profile: Readonly<ModelProfile>;
}
export interface ThreadTarget {
  threadId?: string;
}
type Observer = (event: StreamEvent) => unknown;
interface QueuedInput {
  receipt: QueuedInputReceipt;
  thread: Thread;
  model: ModelRef;
  modelOptions?: JsonObject;
  messages: readonly MessageData[];
}
interface Foreground {
  thread: Thread;
  stream?: Stream;
  status: string;
  done: Promise<void>;
  close: () => void;
  admitted: boolean;
  closed: boolean;
}

export class Session {
  private readonly view = new StateView();
  readonly state = Object.freeze({ get: (): RuntimeState => this.view.get() });
  isIdle(): boolean {
    return !this.busy && this.queue.length === 0;
  }
  isDisposed(): boolean {
    return this.disposed;
  }
  /** @internal Hydrate once on selection/restoration; state.get() never reads storage. */
  async restoreState(): Promise<void> {
    const empty = new StateView().get();
    if (!this.selection) {
      this.view.update(empty);
      return;
    }
    const snapshot = await this.selection.snapshot();
    const stream = snapshot.activeStreamId
      ? await this.selection.getStream(snapshot.activeStreamId)
      : null;
    const interruptId = snapshot.execution?.pendingInterruptId;
    const tools = stream
      ? await this.controller.backend.executions.listRecords(
          "tool_executions",
          this.selection.id,
        )
      : [];
    this.view.update({
      ...empty,
      messages: snapshot.state.messages,
      status: stream?.status ?? "idle",
      interrupt: interruptId
        ? await this.selection.getInterrupt(interruptId)
        : null,
      tools: tools
        .filter((tool) => tool.streamId === stream?.id)
        .map(stateTool),
      queuedInputs: this.queue.length,
    });
  }
  private publishState(patch: Partial<RuntimeState> = {}): void {
    this.notify(stateChanged, {
      state: this.view.update({ ...patch, queuedInputs: this.queue.length }),
    });
  }
  readonly agent;
  private readonly sessionScope: Scope;
  readonly id: string;
  metadata(): JsonObject {
    return this.record.metadata;
  }
  scope(): Scope {
    return this.sessionScope;
  }
  private selection: Thread | null = null;
  private selectedModel: Model;
  private readonly observers = new Set<Observer>();
  private readonly queue: QueuedInput[] = [];
  private readonly blocked = new Set<string>();
  private foreground?: Foreground;
  private disposed = false;
  private closing = false;
  private disposal?: Promise<void>;
  private sequence = 0;
  private controlPending = false;
  private signalAdmission?: Promise<void>;
  /** @internal */ selectsSignalThread(threadId: string): boolean {
    return !this.disposed && !this.closing && this.selection?.id === threadId;
  }
  /** @internal */ async receiveSignal(
    threadId: string,
    message: MessageData,
    persist: boolean,
    deliver: () => Promise<boolean>,
  ): Promise<void> {
    this.check();
    await this.assertCurrent();
    if (!this.selectsSignalThread(threadId))
      fail("ThreadNotSelected", "Signal Thread is no longer selected");
    if (await deliver()) return;
    const admission = (this.signalAdmission ?? Promise.resolve()).then(
      async () => {
        if (await deliver()) return;
        await this.foreground?.done;
        await this.control(async () => {
          if (!this.selectsSignalThread(threadId))
            fail("ThreadNotSelected", "Signal Thread is no longer selected");
          const thread = await this.target(threadId);
          this.checkSelectionChange();
          await this.attach(
            thread,
            {
              input: [message],
              model: this.record.selectedModel.ref,
              modelOptions: this.record.selectedModel.options,
              initialSignal: { persist },
            },
            true,
          );
        });
      },
    );
    this.signalAdmission = admission;
    void admission
      .catch((error) => this.controller.report(errorInfo(error)))
      .finally(() => {
        if (this.signalAdmission === admission)
          this.signalAdmission = undefined;
      });
  }

  private async control<T>(action: () => Promise<T>): Promise<T> {
    this.check();
    if (this.controlPending)
      fail("SessionBusy", "Session control operation is pending");
    this.controlPending = true;
    try {
      await this.assertCurrent();
      return await action();
    } finally {
      this.controlPending = false;
    }
  }

  /** @internal */
  static create(
    controller: Controller,
    record: SessionRecord,
    model: Model,
    modelCatalog: ModelRegistry,
    thread: Thread | null = null,
  ): Session {
    return new Session(controller, record, model, modelCatalog, thread);
  }
  private constructor(
    readonly controller: Controller,
    private record: SessionRecord,
    model: Model,
    private readonly modelCatalog: ModelRegistry,
    thread: Thread | null = null,
  ) {
    controller.requireReady();
    this.agent = controller.agent;
    this.sessionScope = record.scope;
    this.id = record.id;
    this.selection = thread;
    this.selectedModel = model;
  }
  /** @internal Called only after durable creation, never on restoration. */
  created(): void {
    this.notify(sessionHooks.created, { model: this.selectedModel.ref });
  }
  private async persist(
    patch: Partial<Pick<SessionRecord, "selectedThreadId" | "selectedModel">>,
  ): Promise<void> {
    const previous = this.record;
    const next = immutable({
      ...previous,
      ...patch,
      revision: previous.revision + 1,
      updatedAt: this.agent.clock.now(),
    });
    await this.controller.backend.sessions.compareAndSet(
      next,
      previous.revision,
    );
    this.record = next;
  }
  private async assertCurrent(): Promise<void> {
    const expected = this.record;
    const stored = await this.controller.backend.sessions.get(this.id, {
      scope: this.scope(),
    });
    this.check();
    if (
      !stored ||
      stored.revision !== expected.revision ||
      this.record !== expected
    )
      fail("CommitConflict", "Session changed; restore a current handle");
  }
  readonly model = Object.freeze({
    get: (): string => this.modelId(this.selectedModel.ref),
    name: (): string => this.selectedModel.ref.modelId,
    info: (): SessionModelInfo & { readonly options?: JsonObject } => {
      this.check();
      return immutable({
        id: this.model.get(),
        name: this.model.name(),
        profile: this.selectedModel.profile(),
        ...(this.record.selectedModel.options !== undefined
          ? { options: this.record.selectedModel.options }
          : {}),
      });
    },
    list: (): readonly SessionModelInfo[] => {
      this.check();
      const models = new Map(
        this.modelCatalog
          .list()
          .map((model) => [this.modelId(model.ref), model]),
      );
      models.set(this.model.get(), this.selectedModel);
      return immutable(
        [...models].map(([id, model]) => ({
          id,
          name: model.ref.modelId,
          profile: model.profile(),
        })),
      );
    },
    switch: (modelId: string, options?: JsonObject): Promise<void> =>
      this.switchModel(modelId, options),
    setEffort: (level: string): Promise<void> =>
      this.control(async () => {
        requireId(level, "effort level");
        const selected = this.controller.sessionModel(this.selectedModel.ref);
        if (!selected.adapter.effortOptions)
          fail(
            "UnsupportedOption",
            "This provider does not support effort selection",
          );
        const options = selected.adapter.effortOptions(
          level,
          this.record.selectedModel.options ?? {},
        );
        await this.changeModel(this.model.get(), options);
      }),
  });
  private modelId(ref: ModelRef): string {
    return ref.providerId + "/" + ref.modelId;
  }
  private check(): void {
    this.controller.requireReady();
    if (this.disposed || this.closing)
      fail("Disposed", "Session is closing or disposed");
  }
  private get busy(): boolean {
    return this.foreground?.status === "running";
  }
  private checkSelectionChange(): void {
    this.check();
    if (this.busy) fail("SessionBusy", "Session has active work");
  }
  private checkThreadSelectionChange(): void {
    this.checkSelectionChange();
    if (this.queue.length) fail("SessionBusy", "Session has queued input");
  }
  private selected(id?: string): string {
    const value = id ?? this.selection?.id;
    if (!value) fail("ThreadNotSelected", "Select or create a Thread first");
    return value;
  }
  private async target(id?: string): Promise<Thread> {
    const thread = await getThread(this.controller, this.selected(id), {
      scope: this.scope(),
    });
    if (!thread) fail("ThreadNotFound", "Thread does not match Session scope");
    return thread;
  }
  private switchModel(modelId: string, options?: JsonObject): Promise<void> {
    return this.control(() => this.changeModel(modelId, options));
  }
  private async changeModel(
    modelId: string,
    options?: JsonObject,
  ): Promise<void> {
    requireId(modelId, "model id");
    validateModelOptions(options);
    const previous = this.selectedModel.ref;
    const slash = modelId.indexOf("/");
    const ref =
      slash < 0
        ? { ...previous, modelId }
        : modelId.slice(0, slash) === previous.providerId
          ? { ...previous, modelId: modelId.slice(slash + 1) }
          : {
              providerId: modelId.slice(0, slash),
              modelId: modelId.slice(slash + 1),
            };
    const selected = this.controller.sessionModel(ref),
      next = selected.model;
    const effective =
      options === undefined
        ? selected.stored.options
        : snapshotModelOptions({ ...selected.stored.options, ...options });
    const payload = immutable({
      previous,
      model: next.ref,
      ...(this.record.selectedModel.options !== undefined
        ? { previousOptions: this.record.selectedModel.options }
        : {}),
      ...(effective !== undefined ? { options: effective } : {}),
    });
    const modelChanged = canonicalJson(previous) !== canonicalJson(next.ref);
    const optionsChanged =
      canonicalJson(this.record.selectedModel.options ?? null) !==
      canonicalJson(effective ?? null);
    if (!modelChanged && !optionsChanged) return;
    await this.controller.hooks.authorize(
      sessionHooks.model.beforeChange,
      payload,
      this.context(),
    );
    this.check();
    await this.persist({
      selectedModel: {
        ...selected.stored,
        ...(effective !== undefined ? { options: effective } : {}),
      },
    });
    this.selectedModel = next;
    if (modelChanged) this.notify(sessionHooks.modelChanged, payload);
    if (optionsChanged)
      this.notify(sessionHooks.model.optionsChanged, {
        model: next.ref,
        ...(payload.previousOptions !== undefined
          ? { previousOptions: payload.previousOptions }
          : {}),
        ...(payload.options !== undefined ? { options: payload.options } : {}),
      });
  }
  subscribe(observer: Observer): () => void;
  subscribe<N extends AnyEvent>(
    name: N,
    observer: (event: EventEnvelope<PayloadOf<N>, N>) => unknown,
  ): () => void;
  subscribe(
    nameOrObserver: AnyEvent | Observer,
    observer?: (event: any) => unknown,
  ): () => void {
    this.check();
    const handler: Observer =
      typeof nameOrObserver === "function"
        ? nameOrObserver
        : (event) => {
            if (event.type === nameOrObserver) return observer!(event);
          };
    this.observers.add(handler);
    return () => {
      this.observers.delete(handler);
    };
  }
  private emit(event: EventEnvelope): void {
    if (event.type === stateChanged) {
      const snapshot = event.payload.state as RuntimeState;
      if (snapshot !== this.view.get())
        this.view.update({ ...snapshot, queuedInputs: this.queue.length });
      event = new EventEnvelope(
        stateChanged,
        { state: this.view.get() },
        event,
      );
    }
    for (const observer of [...this.observers])
      notifyObserver(observer, event as StreamEvent, this.controller.report);
  }
  private context() {
    return {
      session: this,
      sessionId: this.id,
      controllerId: this.controller.id,
      agentId: this.agent.id,
      scope: this.scope(),
      threadId: this.selection?.id,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
    };
  }
  private notify<N extends AnyEvent>(
    name: N,
    payload: PayloadOf<N>,
    identity: Partial<EventContext> & { thread?: Thread } = {},
  ): Promise<void> {
    const context = { ...this.context(), ...identity };
    this.emit(new EventEnvelope(name, payload, context));
    return this.controller.hooks
      .dispatch(name, payload, context)
      .then(() => {})
      .catch((error) => this.controller.report(errorInfo(error)));
  }
  readonly thread = {
    create: (options: SessionThreadOptions = {}): Promise<Thread> =>
      this.control(async () => {
        this.checkThreadSelectionChange();
        if (
          Object.keys(options).some(
            (key) => !["id", "title", "messages", "metadata"].includes(key),
          )
        )
          fail(
            "InvalidConfiguration",
            "Thread creation accepts id, title, messages and metadata only",
          );
        const thread = await createThread(
          this.controller,
          {
            ...options,
            scope: this.scope(),
          },
          this,
        );
        this.checkThreadSelectionChange();
        await this.persist({ selectedThreadId: thread.id });
        this.selection = thread;
        await this.restoreState();
        this.notify(
          threadHooks.started,
          await this.controller.queries.requireThread(thread.id),
          { threadId: thread.id, thread, scope: thread.scope() },
        );
        this.publishState();
        return thread;
      }),
    switch: (id: string): Promise<Thread> =>
      this.control(async () => {
        this.checkThreadSelectionChange();
        const thread = await this.target(id);
        this.checkThreadSelectionChange();
        const previousThreadId = this.selection?.id ?? null;
        await this.controller.hooks.authorize(
          sessionHooks.thread.beforeSwitch,
          immutable({ previousThreadId, threadId: id }),
          this.context(),
        );
        this.checkThreadSelectionChange();
        const snapshot = await thread.snapshot();
        this.checkThreadSelectionChange();
        await this.persist({ selectedThreadId: thread.id });
        this.selection = thread;
        if (snapshot.activeStreamId) this.blocked.add(id);
        else this.blocked.delete(id);
        await this.restoreState();
        this.notify(sessionHooks.threadSwitched, {
          previousThreadId,
          threadId: id,
        });
        this.publishState();
        return thread;
      }),
    get: (id: string): Promise<Thread | null> => {
      this.check();
      return getThread(this.controller, id, { scope: this.scope() });
    },
    getId: (): string | null => this.selection?.id ?? null,
    list: (options: PageOptions = {}) => {
      this.check();
      return listThreads(this.controller, { ...options, scope: this.scope() });
    },
    rename: (title: string, target: ThreadTarget = {}): Promise<void> =>
      this.control(async () => {
        this.check();
        const id = this.selected(target.threadId);
        await renameThread(
          this.controller,
          id,
          title,
          { scope: this.scope() },
          this,
        );
        const thread = await this.target(id);
        this.notify(
          threadHooks.renamed,
          { threadId: id, title },
          { threadId: id, thread, scope: thread.scope() },
        );
      }),
    fork: (options: ForkOptions & ThreadTarget = {}): Promise<Thread> =>
      this.control(async () => {
        this.check();
        const sourceThreadId = this.selected(options.threadId),
          thread = await forkThread(
            this.controller,
            sourceThreadId,
            {
              ...options,
              scope: this.scope(),
            },
            this,
          );
        const source = await this.target(sourceThreadId);
        this.notify(
          threadHooks.forked,
          { threadId: sourceThreadId, forkedThreadId: thread.id },
          { threadId: sourceThreadId, thread: source, scope: source.scope() },
        );
        return thread;
      }),
    delete: (target: ThreadTarget = {}): Promise<void> =>
      this.removeThread(target, false),
    purge: (target: ThreadTarget = {}): Promise<void> =>
      this.removeThread(target, true),
    getHistory: async (options: HistoryOptions & ThreadTarget = {}) => {
      this.check();
      return (await this.target(options.threadId)).getHistory(options);
    },
  };
  private removeThread(
    target: ThreadTarget,
    permanent: boolean,
  ): Promise<void> {
    return this.control(async () => {
      this.check();
      const id = this.selected(target.threadId);
      const info = await this.controller.backend.threads.get(id, {
        includeDeleted: true,
      });
      const thread = info ? Thread.create(this.controller, info) : undefined;
      await (permanent ? purgeThread : deleteThread)(
        this.controller,
        id,
        { scope: this.scope() },
        this,
      );
      const stored = await this.controller.backend.sessions.get(this.id, {
        scope: this.scope(),
      });
      const expected = {
        ...this.record,
        selectedThreadId:
          this.record.selectedThreadId === id
            ? null
            : this.record.selectedThreadId,
        revision:
          this.record.revision + (this.record.selectedThreadId === id ? 1 : 0),
        updatedAt: stored?.updatedAt,
      };
      if (!stored || canonicalJson(stored) !== canonicalJson(expected))
        fail(
          "CommitConflict",
          "Session changed during thread deletion; restore a current handle",
        );
      this.record = stored;
      if (this.selection?.id === id) this.selection = null;
      if (!this.selection) {
        await this.restoreState();
        this.publishState();
      }
      this.notify(
        threadHooks.deleted,
        { threadId: id, permanent },
        { threadId: id, thread, scope: thread?.scope() ?? this.scope() },
      );
    });
  }
  readonly followUp = Object.assign(
    async (
      input: string | MessageData | readonly MessageData[],
    ): Promise<QueuedInputReceipt> => {
      this.check();
      if (!this.selection)
        fail("ThreadNotSelected", "Select or create a Thread first");
      await this.assertCurrent();
      const receipt = immutable({
        id: randomIds.next("input"),
        threadId: this.selection.id,
      });
      this.queue.push({
        receipt,
        thread: this.selection,
        model: immutable(this.record.selectedModel.ref),
        modelOptions: this.record.selectedModel.options,
        messages: inputMessages(
          typeof input === "string" ? new HumanMessage(input) : input,
        ),
      });
      this.notify(sessionHooks.inputQueued, { receipt });
      this.publishState();
      queueMicrotask(() => this.pump());
      return receipt;
    },
    {
      count: (): number => this.queue.length,
      isEmpty: (): boolean => this.queue.length === 0,
    },
  );
  private discard(cause: string): void {
    for (const entry of this.queue.splice(0))
      this.notify(sessionHooks.inputDiscarded, {
        receipt: entry.receipt,
        cause,
      });
    this.publishState();
  }
  private pump(): void {
    if (
      this.disposed ||
      this.closing ||
      this.busy ||
      (this.foreground && !this.foreground.closed) ||
      !this.queue.length ||
      this.blocked.has(this.queue[0]!.thread.id)
    )
      return;
    const entry = this.queue.shift()!;
    void this.attach(
      entry.thread,
      {
        input: entry.messages,
        model: entry.model,
        modelOptions: entry.modelOptions,
      },
      true,
    ).catch(() => {});
  }
  private attach(
    thread: Thread,
    options: ThreadStreamOptions,
    input: boolean,
  ): Promise<ExecutionReceipt> {
    const previous = this.foreground;
    const { promise: done, resolve: close } = Promise.withResolvers<void>();
    const foreground: Foreground = {
      thread,
      status: "running",
      done,
      close,
      admitted: false,
      closed: false,
    };
    this.foreground = foreground;
    this.publishState({ status: "running", interrupt: null, error: null });
    return new Promise((resolve, reject) => {
      const rejected = (error: ErrorInfo) => {
        reject(errorFromInfo(error));
      };
      const closed = () => {
        foreground.closed = true;
        foreground.close();
        if (!foreground.admitted && !input) {
          this.foreground = previous;
          return;
        }
        if (this.foreground === foreground) {
          if (
            foreground.status === "suspended" ||
            foreground.status === "interrupted"
          )
            this.blocked.add(thread.id);
          else {
            this.foreground = undefined;
            if (foreground.status !== "completed")
              this.discard(foreground.status);
          }
        }
        queueMicrotask(() => this.pump());
      };
      try {
        foreground.stream = thread.admit(
          options,
          {
            kind: "observer",
            admitted: (receipt) => {
              foreground.admitted = true;
              this.blocked.delete(thread.id);
              resolve(receipt);
            },
            rejected,
            observe: (event) => {
              if (event.type === streamHooks.end)
                foreground.status = event.payload.status;
              if (event.type === streamHooks.suspended)
                foreground.status = "suspended";
              if (event.type === streamHooks.error)
                foreground.status = event.payload.persistedStatus ?? "failed";
              this.emit(event);
            },
            closed,
          },
          this,
        );
      } catch (error) {
        foreground.status = "failed";
        this.publishState({ status: "failed", error: errorInfo(error) });
        rejected(errorInfo(error));
        closed();
      }
    });
  }
  private async continue(
    options: ThreadStreamOptions,
  ): Promise<ExecutionReceipt> {
    this.check();
    if (this.busy) fail("SessionBusy", "Session has active work");
    await this.assertCurrent();
    const thread = await this.target();
    if (this.busy) fail("SessionBusy", "Session has active work");
    await this.foreground?.done;
    this.check();
    if (this.busy) fail("SessionBusy", "Session has active work");
    const ref = options.model ?? (await thread.snapshot()).execution?.modelRef;
    const adapter = ref ? this.controller.sessionModel(ref).adapter : undefined;
    return this.attach(thread, { ...options, adapter }, false);
  }
  resume(options: {
    interruptId: string;
    value: JsonValue;
    model?: Model | ModelRef;
  }): Promise<ExecutionReceipt> {
    return this.continue({
      resume: { interruptId: options.interruptId, value: options.value },
      model: options.model,
    });
  }
  recover(options: {
    streamId: string;
    model?: Model | ModelRef;
  }): Promise<ExecutionReceipt> {
    return this.continue({
      recover: { streamId: options.streamId },
      model: options.model,
    });
  }
  async abort(reason = "Cancelled"): Promise<void> {
    this.check();
    const foreground = this.foreground;
    if (foreground?.status === "running") {
      foreground.stream?.abort(reason);
      await foreground.done;
      return;
    }
    const thread = await this.target(),
      snapshot = await thread.snapshot();
    if (!snapshot.activeStreamId) return;
    await foreground?.done;
    await this.agent.cancel(
      thread.id,
      snapshot.activeStreamId,
      reason,
      {
        kind: "observer",
        observe: (event) => this.emit(event),
      },
      { session: this, thread },
    );
    this.blocked.delete(thread.id);
    this.foreground = undefined;
    this.discard("cancelled");
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.disposal) return this.disposal;
    if (this.controlPending)
      fail("SessionBusy", "Session control operation is pending");
    this.checkSelectionChange();
    return this.close();
  }
  /** @internal Controller closes handles while its runtime is shutting down. */
  close(force = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.disposal)
      return force
        ? this.disposal.catch(() => this.close(true))
        : this.disposal;
    this.closing = true;
    this.disposal = (async () => {
      try {
        await this.foreground?.done;
        this.discard("Closed");
        this.disposed = true;
        this.publishState({ status: "closed" });
        this.controller.forgetSession(this);
        await this.notify(sessionHooks.closed, {});
        this.observers.clear();
      } catch (error) {
        this.closing = false;
        this.disposal = undefined;
        queueMicrotask(() => this.pump());
        throw error;
      }
    })();
    return this.disposal;
  }
}
