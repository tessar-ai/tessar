import { fail, errorInfo } from "../errors.js";
import { assertJson } from "../json.js";
import { MessageCodec } from "../messages/codec.js";
import type { ThreadInfo } from "./schema.js";
import type { StreamRecord } from "../trace/records.js";
import type {
  CommitBatch,
  CommitReceipt,
  Lease,
  StorageBackend,
} from "./storage-ports.js";

const INVALID_MESSAGE = "InvalidMessage";

export function buildThreadInfo(
  batch: CommitBatch,
  head: ThreadInfo | null | undefined,
  stream: StreamRecord | null | undefined,
): ThreadInfo {
  const cp = batch.checkpoint;
  return {
    id: batch.threadId,
    scope: cp.state.scope,
    metadata: cp.state.metadata,
    revision: cp.revision,
    currentCheckpointId: cp.id,
    activeStreamId:
      stream &&
        !["completed", "failed", "stopped", "cancelled"].includes(stream.status)
        ? stream.id
        : null,
    createdAt: head?.createdAt ?? cp.createdAt,
    updatedAt: cp.createdAt,
    parentThreadId:
      batch.lineage?.parentThreadId ?? head?.parentThreadId ?? null,
    sourceCheckpointId:
      batch.lineage?.sourceCheckpointId ?? head?.sourceCheckpointId ?? null,
    deleted: batch.deleteThread ?? false,
  };
}
export function canonicalJson(value: unknown): string {
  assertJson(value);
  const encode = (x: any): string =>
    Array.isArray(x)
      ? "[" + x.map(encode).join(",") + "]"
      : x && typeof x === "object"
        ? "{" +
        Object.keys(x)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + encode(x[k]))
          .join(",") +
        "}"
        : JSON.stringify(x);
  return encode(value);
}
export async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export const commitFingerprint = (batch: CommitBatch): Promise<string> =>
  fingerprint(batch);
export function validateBatch(batch: CommitBatch): void {
  assertJson(batch);
  const cp = batch.checkpoint;
  if (
    cp.threadId !== batch.threadId ||
    cp.revision !== batch.expectedRevision + 1 ||
    cp.schemaVersion !== 1
  )
    fail("CommitConflict", "Checkpoint identity/revision mismatch");
  const ids = new Set<string>(),
    pending = new Set<string>(),
    resolved = new Set<string>();
  for (const wire of cp.state.messages) {
    const message = MessageCodec.decode(wire);
    if (ids.has(message.id)) fail(INVALID_MESSAGE, "Duplicate message ID");
    ids.add(message.id);
    for (const part of message.content)
      if (part.type === "tool-call") {
        if (
          message.role !== "assistant" ||
          pending.has(part.toolCallId) ||
          resolved.has(part.toolCallId)
        )
          fail(INVALID_MESSAGE, "Invalid tool call");
        pending.add(part.toolCallId);
      }
    if (message.role === "tool") {
      if (!pending.has(message.toolCallId!))
        fail(INVALID_MESSAGE, "Unmatched tool result");
      pending.delete(message.toolCallId!);
      resolved.add(message.toolCallId!);
    }
  }
  if (cp.cause === "Terminal" && pending.size)
    fail(
      INVALID_MESSAGE,
      "Terminal checkpoint contains unresolved tool calls",
    );
  for (const entry of batch.records)
    if (
      entry.threadId !== batch.threadId ||
      entry.id !== ("id" in entry.data ? entry.data.id : entry.id)
    )
      fail("CommitConflict", "Record membership mismatch");
}
export class CommitCoordinator {
  constructor(private readonly backend: StorageBackend) { }
  async commit(batch: CommitBatch, lease: Lease): Promise<CommitReceipt> {
    validateBatch(batch);
    try {
      await this.backend.commits.stage(batch);
      const existing = await this.backend.commits.lookupCommit(batch.commitId);
      if (existing) return existing;
      if (lease.threadId !== batch.threadId)
        fail("OwnershipLost", "Lease belongs to another thread");
      try {
        return await this.backend.commits.publish({
          commitId: batch.commitId,
          threadId: batch.threadId,
          expectedRevision: batch.expectedRevision,
          lease,
        });
      } catch (error) {
        const committed = await this.backend.commits.lookupCommit(
          batch.commitId,
        );
        if (committed) return committed;
        throw error;
      }
    } catch (error) {
      errorInfo(error, { source: "storage", backendId: this.backend.id });
      throw error;
    }
  }
}
