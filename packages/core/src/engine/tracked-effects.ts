import {
  fail,
  requireId,
  TessarError,
  errorInfo,
  errorFromInfo,
  type ErrorInfo,
} from "../errors.js";
import {
  assertJson,
  immutable,
  type JsonValue,
  type JsonObject,
} from "../json.js";
import type { InputDefinition } from "../tools/input-definition.js";
import type { ModelChunk, ModelRef, ModelRequest } from "../models/contract.js";
import type { AnyEvent, PayloadOf } from "../events/definition.js";
import type { HookContext } from "../plugins/context.js";
import {
  PluginStateAccess,
  type PluginStateDefinition,
} from "../state/plugin-state.js";
import { canonicalJson } from "../state/commit.js";
import { abortable } from "./abort.js";
export interface EffectContext {
  signal: AbortSignal;
  threadId: string;
  streamId: string;
  turnId: string | null;
  toolExecutionId?: string;
  operationId: string;
  key: string;
}
export interface EffectDefinition<I = any, O = any> {
  id: string;
  version: number;
  input: InputDefinition<I>;
  output: InputDefinition<O>;
  execute: (input: I, context: EffectContext) => Promise<O>;
  reconcile?: (operation: {
    input: I;
    key: string;
    id: string;
  }) => Promise<
    | { status: "completed"; output: O }
    | { status: "safeToRetry" }
    | { status: "unknown" }
  >;
}
export function defineEffect<I, O>(
  definition: EffectDefinition<I, O>,
): EffectDefinition<I, O> {
  requireId(definition.id);
  if (!Number.isInteger(definition.version) || definition.version < 1)
    fail("InvalidConfiguration", "Invalid effect version");
  return Object.freeze({ ...definition });
}
export interface EffectBinding {
  definition: EffectDefinition;
  pluginId: string;
  stateDefinition: PluginStateDefinition<JsonObject>;
}
export interface TrackedServices {
  models: {
    stream(options: {
      model: ModelRef;
      request: ModelRequest;
      purpose: "auxiliary";
    }): AsyncIterable<ModelChunk>;
  };
  effects: {
    execute<I, O>(
      definition: EffectDefinition<I, O>,
      input: I,
      options: { key: string },
    ): Promise<O>;
  };
  events: {
    emit<D extends AnyEvent>(
      definition: D,
      payload: PayloadOf<D>,
    ): Promise<void>;
  };
}
export interface ExecutionHookContext extends HookContext, TrackedServices {
  readonly state: PluginStateAccess;
  readonly signal: AbortSignal;
  readonly threadId: string;
  readonly streamId: string;
}
type EffectRecord = {
  digest: string;
  status: "pending" | "dispatched" | "completed" | "failed" | "unknown";
  input: JsonValue;
  output?: JsonValue;
  error?: JsonValue;
  operationId: string;
};
export class EffectService {
  constructor(
    private readonly lookup: (id: string) => EffectBinding | undefined,
    private readonly state: PluginStateAccess,
    private readonly commit: () => Promise<void>,
    private readonly context: Omit<EffectContext, "key" | "operationId">,
    private readonly nextId: () => string,
    private readonly locks: Map<string, Promise<unknown>>,
  ) {}
  async execute<I, O>(
    definition: EffectDefinition<I, O>,
    input: I,
    options: { key: string },
  ): Promise<O> {
    requireId(options.key, "effect key");
    const parsed = definition.input.parse(input);
    assertJson(parsed);
    const lock = definition.id + ":" + options.key,
      digest = canonicalJson({
        id: definition.id,
        version: definition.version,
        input: parsed,
      });
    const previous = this.locks.get(lock);
    if (previous) {
      try {
        await previous;
      } catch {
        /* inspect committed outcome below */
      }
    }
    const operation = this.perform(definition, parsed, options.key, digest);
    this.locks.set(lock, operation);
    try {
      return await operation;
    } finally {
      if (this.locks.get(lock) === operation) this.locks.delete(lock);
    }
  }
  private async perform<I, O>(
    definition: EffectDefinition<I, O>,
    input: I,
    key: string,
    digest: string,
  ): Promise<O> {
    const binding = this.lookup(definition.id);
    if (!binding || binding.definition.version !== definition.version)
      fail("ResumeIncompatible", "Effect contract is missing");
    const data = this.state.get(binding.stateDefinition),
      prior = data[key] as unknown as EffectRecord | undefined;
    if (prior && prior.digest !== digest)
      fail(
        "CommitConflict",
        "Effect key reused with another input or contract",
      );
    const save = async (record: EffectRecord) => {
      this.state.update(binding.stateDefinition, (previous) => ({
        ...previous,
        [key]: record as unknown as JsonValue,
      }));
      await this.commit();
    };
    if (prior?.status === "completed")
      return immutable(definition.output.parse(prior.output)) as O;
    if (prior?.status === "failed") {
      throw errorFromInfo(prior.error as unknown as ErrorInfo);
    }
    const operationId = prior?.operationId ?? this.nextId();
    if (prior) {
      const outcome = definition.reconcile
        ? await definition.reconcile({ input, key, id: operationId })
        : { status: "unknown" as const };
      if (outcome.status === "unknown")
        fail("RecoveryRequired", "Effect dispatch outcome is unknown");
      if (outcome.status === "completed") {
        const output = definition.output.parse(outcome.output);
        assertJson(output);
        await save({
          digest,
          status: "completed",
          input: input as JsonValue,
          output: output as JsonValue,
          operationId,
        });
        return immutable(output) as O;
      }
    }
    await save({
      digest,
      status: "dispatched",
      input: input as JsonValue,
      operationId,
    });
    try {
      const output = definition.output.parse(
        await abortable(
          definition.execute(input, { ...this.context, key, operationId }),
          this.context.signal,
          () =>
            new TessarError(
              "RecoveryRequired",
              "Effect cancelled with unknown external outcome",
            ),
        ),
      );
      assertJson(output);
      await save({
        digest,
        status: "completed",
        input: input as JsonValue,
        output: output as JsonValue,
        operationId,
      });
      return immutable(output) as O;
    } catch (error) {
      const info = errorInfo(error, {
          source: "plugin",
          pluginId: binding.pluginId,
        }),
        unknown =
          ["StorageUnavailable", "OwnershipLost", "RecoveryRequired"].includes(
            info.code,
          ) || info.source === "storage";
      await save({
        digest,
        status: unknown ? "unknown" : "failed",
        input: input as JsonValue,
        error: info as unknown as JsonValue,
        operationId,
      });
      if (unknown)
        fail("RecoveryRequired", "Effect outcome requires reconciliation");
      throw error;
    }
  }
}
