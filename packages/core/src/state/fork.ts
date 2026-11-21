import { fail, requireId } from "../errors.js";
import { randomIds, type JsonObject } from "../helpers/json.js";
import type { StorageBackend } from "./storage-ports.js";
import type { StateQuery, ThreadInfo } from "./schema.js";
import { StateQueries, checkpointSafety } from "./queries.js";
import { ThreadService } from "./threads.js";
import type { PluginStateDefinition } from "./plugin-state.js";
export interface ForkOptions {
  id?: string;
  atCheckpointId?: string;
  atMessageId?: string;
  metadata?: JsonObject;
}
export class ForkService {
  constructor(
    private readonly backend: StorageBackend,
    private readonly definitions: readonly PluginStateDefinition<any>[] = [],
  ) {}
  async fork(
    sourceId: string,
    options: ForkOptions & StateQuery = {},
  ): Promise<ThreadInfo> {
    const queries = new StateQueries(this.backend),
      source = await queries.requireThread(sourceId, options);
    if (options.atCheckpointId && options.atMessageId)
      fail("InvalidConfiguration", "Fork selectors are mutually exclusive");
    let cp = options.atCheckpointId
      ? await queries.getCheckpoint(sourceId, options.atCheckpointId, options)
      : await queries.snapshot(sourceId, options);
    if (options.atMessageId) {
      const matches = (await this.backend.checkpoints.list(sourceId)).filter(
        (c) => c.state.messages.at(-1)?.id === options.atMessageId,
      );
      cp = matches.sort((a, b) => a.revision - b.revision)[0] ?? null;
    }
    if (!cp) fail("CheckpointNotFound", "No exact fork checkpoint");
    if (!checkpointSafety(cp).forkable)
      fail("UnsafeForkPoint", "Fork prefix contains unresolved tool calls");
    const targetId = requireId(
      options.id ?? randomIds.next("thread"),
      "thread id",
    );
    const states = cp.state.pluginStates
      .filter((s) => s.ownerType === "thread")
      .map((s) => {
        const definition = this.definitions.find(
          (d) => d.pluginId === s.pluginId && d.namespace === s.namespace,
        );
        if (definition?.fork === "reset")
          return { ...s, data: definition.initial, revision: 0 };
        if (typeof definition?.fork === "function")
          return {
            ...s,
            data: definition.fork(s.data, {
              sourceThreadId: sourceId,
              targetThreadId: targetId,
            }),
            revision: 0,
          };
        return { ...s, revision: 0 };
      });
    return new ThreadService(this.backend).create(
      {
        id: targetId,
        scope: source.scope,
        instructions: cp.state.instructions ?? undefined,
        messages: cp.state.messages,
        metadata: { ...cp.state.metadata, ...options.metadata },
      },
      {
        pluginStates: states,
        lineage: { parentThreadId: sourceId, sourceCheckpointId: cp.id },
      },
    );
  }
}
