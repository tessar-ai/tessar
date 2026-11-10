import type { Collection, ClientSession, Filter } from "mongodb";
import {
  canonicalJson,
  immutable,
  checkpointSafety,
  type Checkpoint,
  type MessageData,
} from "@tessar/core";
import { decode, type Row } from "./queries.js";

export const interval = (
  threadId: string,
  kind: string,
  revision: number,
): Filter<Row> => ({
  threadId,
  kind,
  fromRevision: { $lte: revision },
  $or: [{ toRevision: null }, { toRevision: { $gt: revision } }],
});
export async function readVersions<T>(
  versions: Collection<Row>,
  kind: string,
  threadId: string,
  revision: number,
  session: ClientSession,
): Promise<T[]> {
  return (
    await versions
      .find(interval(threadId, kind, revision), { session })
      .sort(kind === "messages" ? { position: 1 } : { sortDate: 1, id: 1 })
      .toArray()
  ).map((row) => decode<T>(row)!);
}
export async function hydrateCheckpoint(
  versions: Collection<Row>,
  row: Row,
  session: ClientSession,
): Promise<Checkpoint> {
  const cp = decode<Checkpoint>(row)!;
  return immutable({
    ...cp,
    state: {
      ...cp.state,
      messages: await readVersions<MessageData>(
        versions,
        "messages",
        cp.threadId,
        cp.revision,
        session,
      ),
    },
  });
}
export async function writeVersions(
  versions: Collection<Row>,
  kind: string,
  threadId: string,
  revision: number,
  entries: readonly { id: string; body: string; position?: number }[],
  session: ClientSession,
  replace = false,
) {
  const current = new Map(
    (
      await versions
        .find({ threadId, kind, toRevision: null }, { session })
        .toArray()
    ).map((row) => [row.id as string, row]),
  );
  for (const entry of entries) {
    const old = current.get(entry.id);
    current.delete(entry.id);
    if (old?.body === entry.body && old.position === (entry.position ?? null))
      continue;
    if (old)
      await versions.updateOne(
        { _id: old._id },
        { $set: { toRevision: revision } },
        { session },
      );
    const value = JSON.parse(entry.body);
    await versions.insertOne(
      {
        _id: canonicalJson([threadId, kind, entry.id, revision]),
        threadId,
        kind,
        id: entry.id,
        fromRevision: revision,
        toRevision: null,
        position: entry.position ?? null,
        streamId: value.streamId ?? null,
        turnId: value.turnId ?? null,
        status: value.status ?? null,
        sortDate: value.createdAt ?? value.startedAt ?? "",
        body: entry.body,
      },
      { session },
    );
  }
  if (replace)
    for (const row of current.values())
      await versions.updateOne(
        { _id: row._id },
        { $set: { toRevision: revision } },
        { session },
      );
}

export async function writeCheckpoint(
  checkpoints: Collection<Row>,
  versions: Collection<Row>,
  cp: Checkpoint,
  session: ClientSession,
): Promise<void> {
  await writeVersions(
    versions,
    "messages",
    cp.threadId,
    cp.revision,
    cp.state.messages.map((message, position) => ({
      id: message.id,
      position,
      body: canonicalJson(message),
    })),
    session,
    true,
  );
  const { messages, ...state } = cp.state;
  await checkpoints.insertOne(
    {
      _id: cp.id,
      id: cp.id,
      threadId: cp.threadId,
      revision: cp.revision,
      sortDate: cp.createdAt,
      cause: cp.cause,
      messageCount: messages.length,
      ...checkpointSafety(cp),
      body: canonicalJson({ ...cp, state }),
    },
    { session },
  );
}
