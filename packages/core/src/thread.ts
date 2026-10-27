import { fail } from "./errors.js";
import { immutable, type JsonObject, type JsonValue } from "./json.js";
import { inputMessages } from "./messages/codec.js";
import type { Controller } from "./controller.js";
import type { Model } from "./models/profile.js";
import type { ModelAdapter, ModelRef } from "./models/contract.js";
import type { MessageData } from "./messages/message.js";
import type {
  PageOptions,
  Scope,
  StreamLimits,
  ThreadInfo,
} from "./state/schema.js";
import type { HistoryOptions } from "./state/queries.js";

import type { DeliveryTarget, Stream } from "./engine/delivery.js";
import { aggregateUsage } from "./trace/usage.js";
import type { SessionHookHandle } from "./plugins/context.js";
/** @internal */
export type ThreadStreamOptions = {
  adapter?: ModelAdapter;
  signal?: AbortSignal;
  context?: JsonObject;
  modelOptions?: JsonObject;
  limits?: Partial<StreamLimits>;
} & (
  | {
      input: MessageData | readonly MessageData[];
      model: Model | ModelRef;
      initialSignal?: { persist: boolean };
      resume?: never;
      recover?: never;
    }
  | {
      input?: never;
      resume: { interruptId: string; value: JsonValue };
      recover?: never;
      model?: Model | ModelRef;
    }
  | {
      input?: never;
      resume?: never;
      recover: { streamId: string };
      model?: Model | ModelRef;
    }
);
export class Thread {
  readonly id: string;
  private readonly threadScope: Scope;
  private disposed = false;
  /** @internal */
  static create(controller: Controller, info: ThreadInfo): Thread {
    return new Thread(controller, info);
  }
  private constructor(
    private readonly controller: Controller,
    info: ThreadInfo,
  ) {
    this.id = info.id;
    this.threadScope = immutable(info.scope);
  }
  scope(): Scope {
    return this.threadScope;
  }
  private check(): void {
    this.controller.requireReady();
    if (this.disposed) fail("Disposed", "Thread handle is disposed");
  }
  private get query() {
    this.check();
    return this.controller.queries;
  }
  private get filter() {
    return { scope: this.scope() };
  }
  async snapshot() {
    const cp = await this.query.snapshot(this.id, this.filter),
      head = await this.query.requireThread(this.id, this.filter),
      attempts = await this.controller.backend.executions.listRecords(
        "model_attempts",
        this.id,
      );
    return {
      ...cp,
      activeStreamId: head.activeStreamId,
      currentCheckpointId: cp.id,
      usage: aggregateUsage(attempts),
    };
  }
  getHistory(options: HistoryOptions = {}) {
    return this.query.getHistory(this.id, options, this.filter);
  }
  getCheckpoint(id: string) {
    return this.query.getCheckpoint(this.id, id, this.filter);
  }
  listCheckpoints(options: PageOptions = {}) {
    return this.query.listCheckpoints(this.id, options, this.filter);
  }
  getStream(id: string) {
    return this.query.getRecord("streams", this.id, id, this.filter);
  }
  listStreams(options: PageOptions = {}) {
    return this.query.listRecords("streams", this.id, options, this.filter);
  }
  listTurns(streamId: string, options: PageOptions = {}) {
    return this.query.listRecords(
      "turns",
      this.id,
      { ...options, streamId },
      this.filter,
    );
  }
  listModelAttempts(turnId: string, options: PageOptions = {}) {
    return this.query.listRecords(
      "model_attempts",
      this.id,
      { ...options, turnId },
      this.filter,
    );
  }
  listToolExecutions(turnId: string, options: PageOptions = {}) {
    return this.query.listRecords(
      "tool_executions",
      this.id,
      { ...options, turnId },
      this.filter,
    );
  }
  getInterrupt(id: string) {
    return this.query.getRecord("interrupts", this.id, id, this.filter);
  }
  listInterrupts(
    options: PageOptions & {
      status?: "pending" | "resolved" | "cancelled";
    } = {},
  ) {
    return this.query.listRecords("interrupts", this.id, options, this.filter);
  }
  /** @internal */ stream(options: ThreadStreamOptions): Stream {
    return this.admit(options, { kind: "iterator" });
  }
  /** @internal */ admit(
    options: ThreadStreamOptions,
    target: DeliveryTarget,
    session?: SessionHookHandle,
  ): Stream {
    this.check();
    const controller = this.controller,
      selection = options.model
        ? controller.sessionModel(options.model)
        : undefined,
      model = selection?.stored.ref;
    const common = {
      threadId: this.id,
      signal: options.signal,
      thread: this,
      session,
      adapter: options.adapter ?? selection?.adapter,
    };
    const prepare = async () => {
      await controller.queries.requireThread(this.id, this.filter);
    };
    if (options.input !== undefined) {
      if (options.resume || options.recover)
        fail("InvalidConfiguration", "Choose one execution command");
      return controller.agent.admit(
        {
          ...common,
          kind: "input",
          input: inputMessages(options.input),
          model: model!,
          context: options.context,
          modelOptions: options.modelOptions,
          limits: options.limits,
          initialSignal: options.initialSignal,
        },
        target,
        prepare,
      );
    }
    if (options.resume) {
      if (options.recover)
        fail("InvalidConfiguration", "Choose one execution command");
      return controller.agent.admit(
        { ...common, kind: "resume", ...options.resume, model },
        target,
        prepare,
      );
    }
    if (options.recover)
      return controller.agent.admit(
        { ...common, kind: "recover", ...options.recover, model },
        target,
        prepare,
      );
    return fail("InvalidConfiguration", "Choose input, resume or recover");
  }
  /** @internal */ async cancelStream(
    streamId: string,
    reason?: string,
  ): Promise<void> {
    this.check();
    await this.query.requireThread(this.id, this.filter);
    await this.controller.agent.cancel(this.id, streamId, reason, undefined, {
      thread: this,
    });
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.check();
    this.disposed = true;
  }
}
