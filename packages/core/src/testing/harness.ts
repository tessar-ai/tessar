import { stream as streamHooks } from "../events/type.js";
import {
  Agent,
  type ExecutionRequest,
  type Stream,
  type DeliveryTarget,
  type AgentTools,
} from "../agent.js";
import { Controller } from "../controller.js";
import type { Plugin } from "../plugins/context.js";
import { createMemoryBackend } from "../state/memory-backend.js";
import type { StorageBackend } from "../state/storage-ports.js";
import { ThreadService, type CreateThreadOptions } from "../state/threads.js";
import type { StreamLimits } from "../state/schema.js";
import { ScriptedProvider, type ModelScript } from "./scripted-provider.js";

import { errorFromInfo } from "../errors.js";
export class AgentHarness {
  private constructor(
    readonly agent: Agent,
    readonly controller: Controller,
    readonly provider: ScriptedProvider,
    readonly backend: StorageBackend,
  ) {}
  /** @internal */ get registry() {
    return this.controller.hooks;
  }
  /** @internal */ get queries() {
    return this.controller.queries;
  }
  static async create(
    options: {
      modelScripts?: readonly ModelScript[];
      plugins?: readonly Plugin[];
      backend?: StorageBackend;
      instructions?: string;
      limits?: Partial<StreamLimits>;
      tools?: AgentTools;
    } = {},
  ): Promise<AgentHarness> {
    const backend = options.backend ?? createMemoryBackend(),
      provider = new ScriptedProvider(options.modelScripts ?? []);
    const agent = new Agent({
      id: "test-agent",
      model: provider.ref,
      instructions: options.instructions,
      limits: options.limits,
      tools: options.tools,
    });
    const controller = new Controller({
      id: "test-controller",
      agent,
      plugins: [
        {
          id: "test-storage",
          setup(tessar) {
            tessar.storage.register(backend);
          },
        },
        {
          id: "scripted",
          setup(tessar) {
            tessar.models.register({
              id: "scripted",
              create: (modelId) => provider.withModel(modelId),
            });
          },
        },
        ...(options.plugins ?? []),
      ],
    });
    await controller.initialize();
    return new AgentHarness(agent, controller, provider, backend);
  }
  admit(request: ExecutionRequest, target?: DeliveryTarget): Stream {
    return this.agent.admit(request, target);
  }
  createThread(options?: CreateThreadOptions) {
    return new ThreadService(this.backend).create(options);
  }
  async collect(stream: Stream) {
    const events = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === streamHooks.error)
        throw errorFromInfo(event.payload.error);
    }
    return events;
  }
  async records(streamId: string) {
    const stream = await this.backend.executions.get("streams", streamId);
    if (!stream) throw Error("No stream record");
    return {
      stream,
      turns: (
        await this.backend.executions.listRecords("turns", stream.threadId)
      ).filter((t) => t.streamId === streamId),
      attempts: (
        await this.backend.executions.listRecords(
          "model_attempts",
          stream.threadId,
        )
      ).filter((a) => a.streamId === streamId),
      tools: (
        await this.backend.executions.listRecords(
          "tool_executions",
          stream.threadId,
        )
      ).filter((t) => t.streamId === streamId),
      messages: (await this.queries.snapshot(stream.threadId)).state.messages,
    };
  }
  checkpoint(threadId: string) {
    return this.queries.snapshot(threadId);
  }
  dispose() {
    return this.controller.dispose();
  }
}
