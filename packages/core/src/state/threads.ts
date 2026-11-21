import { fail, requireId } from "../errors.js";
import {
  randomIds,
  systemClock,
  type IdGenerator,
  type Clock,
  type JsonObject,
} from "../helpers/json.js";
import {
  normalizeInstruction,
  type Instruction,
} from "../instructions/instruction.js";
import type { MessageData } from "../messages/message.js";
import { inputMessages } from "../messages/codec.js";
import type {
  Checkpoint,
  Scope,
  StateQuery,
  ThreadInfo,
  PluginStateSnapshot,
} from "./schema.js";
import type { StorageBackend } from "./storage-ports.js";
import { CommitCoordinator } from "./commit.js";
import { matchesScope, normalizeScope } from "./scope.js";
export interface CreateThreadOptions {
  id?: string;
  title?: string;
  scope?: Scope;
  instructions?: string | Instruction;
  messages?: readonly MessageData[];
  metadata?: JsonObject;
}
export class ThreadService {
  constructor(
    private readonly backend: StorageBackend,
    private readonly ids: IdGenerator = randomIds,
    private readonly clock: Clock = systemClock,
  ) {}
  async create(
    options: CreateThreadOptions = {},
    internal?: {
      pluginStates?: readonly PluginStateSnapshot[];
      lineage?: { parentThreadId: string; sourceCheckpointId: string };
    },
  ): Promise<ThreadInfo> {
    const id = requireId(options.id ?? this.ids.next("thread"), "thread id");
    if (await this.backend.threads.get(id, { includeDeleted: true }))
      fail("RegistrationConflict", "Thread ID already exists: " + id);
    const lease = await this.backend.ownership.acquire({
      threadId: id,
      ownerToken: this.ids.next("owner"),
      ttlMs: 30000,
    });
    try {
      const cp: Checkpoint = {
        id: this.ids.next("checkpoint"),
        threadId: id,
        parentCheckpointId: null,
        revision: 1,
        schemaVersion: 1,
        createdAt: this.clock.now(),
        cause: internal?.lineage ? "ForkCreated" : "ThreadCreated",
        execution: null,
        state: {
          scope: normalizeScope(options.scope),
          metadata: {
            ...options.metadata,
            ...(options.title !== undefined ? { title: options.title } : {}),
          },
          instructions:
            options.instructions !== undefined
              ? normalizeInstruction(options.instructions)
              : null,
          messages: inputMessages(options.messages ?? []),
          pluginStates: (internal?.pluginStates ?? []).map((state) => ({
            ...state,
            ownerId: id,
          })),
        },
      };
      await new CommitCoordinator(this.backend).commit(
        {
          commitId: this.ids.next("commit"),
          threadId: id,
          expectedRevision: 0,
          checkpoint: cp,
          records: [],
          ...(internal?.lineage ? { lineage: internal.lineage } : {}),
        },
        lease,
      );
      return (await this.backend.threads.get(id))!;
    } finally {
      await this.backend.ownership.release(lease);
    }
  }
  async mutate(
    id: string,
    transform: (cp: Checkpoint) => Checkpoint,
    query: StateQuery = {},
    deleteThread = false,
  ): Promise<void> {
    const head = await this.backend.threads.get(id);
    if (!head || !matchesScope(head.scope, query.scope))
      fail("ThreadNotFound", "Thread does not match query");
    if (head.activeStreamId)
      fail("ThreadBusy", "Thread has unfinished execution");
    const lease = await this.backend.ownership.acquire({
      threadId: id,
      ownerToken: this.ids.next("owner"),
      ttlMs: 30000,
    });
    try {
      const cp = (await this.backend.checkpoints.get(
        head.currentCheckpointId,
      ))!;
      const transformed = transform(cp);
      if (
        JSON.stringify(transformed.state.scope) !==
        JSON.stringify(cp.state.scope)
      )
        fail("ThreadScopeMismatch", "Scope cannot be changed");
      const next = {
        ...transformed,
        id: this.ids.next("checkpoint"),
        threadId: id,
        parentCheckpointId: cp.id,
        revision: cp.revision + 1,
        createdAt: this.clock.now(),
      };
      await new CommitCoordinator(this.backend).commit(
        {
          commitId: this.ids.next("commit"),
          threadId: id,
          expectedRevision: cp.revision,
          checkpoint: next,
          records: [],
          ...(deleteThread ? { deleteThread: true } : {}),
        },
        lease,
      );
    } finally {
      await this.backend.ownership.release(lease);
    }
  }
  async rename(
    id: string,
    title: string,
    query: StateQuery = {},
  ): Promise<void> {
    if (typeof title !== "string")
      fail("InvalidConfiguration", "Title must be text");
    return this.mutate(
      id,
      (cp) => ({
        ...cp,
        state: { ...cp.state, metadata: { ...cp.state.metadata, title } },
      }),
      query,
    );
  }
  purge(id: string, query: StateQuery = {}): Promise<void> {
    return this.backend.threads.purge(id, query);
  }
  async delete(id: string, query: StateQuery = {}): Promise<void> {
    return this.mutate(id, (cp) => cp, query, true);
  }
}
