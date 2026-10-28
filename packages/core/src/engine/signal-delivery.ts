import type { Agent } from "../agent.js";
import { fail, TessarError, errorInfo } from "../errors.js";
import type { MessageData } from "../messages/message.js";
import type { LoopContext } from "../loop.js";
import type {
  ExecutionContext,
  ExecutionFrame,
  ExecutionRequest,
} from "./frame.js";
import type { ExecutionRuntime } from "./runtime.js";
import { CommitCoordinator } from "../state/commit.js";

interface TransientMessage {
  after: string | null;
  message: MessageData;
}
interface Mailbox {
  id: string;
  threadId: string;
  runtime: ExecutionRuntime;
  frame?: ExecutionFrame;
  ready: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  accepting: boolean;
  pending: MessageData[];
  applied: TransientMessage[];
  transientInput?: readonly MessageData[];
  order: string[];
  operations: Set<Promise<void>>;
  offline: Promise<void>;
  detaching?: Promise<void>;
  failure?: unknown;
}
const mailboxes = new WeakMap<Agent, Map<string, Mailbox>>();

export function reserveSignals(
  agent: Agent,
  request: ExecutionRequest,
  runtime: ExecutionRuntime,
): void {
  if (request.kind !== "input") return;
  reserveTarget(agent, request.id!, request.threadId, runtime);
}

function reserveTarget(
  agent: Agent,
  id: string,
  threadId: string,
  runtime: ExecutionRuntime,
): Mailbox {
  let entries = mailboxes.get(agent);
  if (!entries) mailboxes.set(agent, (entries = new Map()));
  const { promise: ready, resolve, reject } = Promise.withResolvers<void>();
  void ready.catch(() => {});
  const box: Mailbox = {
    id,
    threadId,
    runtime,
    ready,
    resolve,
    reject,
    accepting: true,
    pending: [],
    applied: [],
    order: [],
    operations: new Set(),
    offline: Promise.resolve(),
  };
  entries.set(id, box);
  return box;
}

export function retainedSignals(
  agent: Agent,
  id: string,
  threadId: string,
  runtime: ExecutionRuntime,
): Mailbox {
  const box =
    mailboxes.get(agent)?.get(id) ??
    reserveTarget(agent, id, threadId, runtime);
  box.resolve();
  return box;
}

export function bindSignals(
  context: ExecutionContext,
  frame: ExecutionFrame,
): void {
  let entries = mailboxes.get(context.agent);
  if (!entries) mailboxes.set(context.agent, (entries = new Map()));
  if (!entries.has(frame.stream.id)) {
    reserveTarget(
      context.agent,
      frame.stream.id,
      frame.cp.threadId,
      context.runtime,
    );
  }
  const box = entries.get(frame.stream.id)!;
  if (box.frame !== frame) box.failure = undefined;
  box.frame = frame;
  frame.signals = box;
  if (frame.admitted) box.resolve();
}

export function releaseSignals(
  agent: Agent,
  id: string,
  outcome?: { status: string },
  error?: unknown,
): void {
  const box = mailboxes.get(agent)?.get(id);
  if (!box) return;
  box.frame = undefined;
  if (outcome?.status === "suspended" || outcome?.status === "interrupted")
    return;
  box.accepting = false;
  box.reject(
    error ??
      new TessarError(
        "InvalidTransition",
        "Execution ended before accepting signal input",
      ),
  );
  mailboxes.get(agent)!.delete(id);
}

export function findSignalTarget(
  agent: Agent,
  target: { streamId?: string; threadId?: string },
): Mailbox | undefined {
  const entries = mailboxes.get(agent);
  return target.streamId !== undefined
    ? entries?.get(target.streamId)
    : [...(entries?.values() ?? [])].find(
        (entry) => entry.threadId === target.threadId,
      );
}

export function deliverSignal(
  context: ExecutionContext,
  box: Mailbox,
  message: MessageData,
  persist: boolean,
): void {
  if (!box.accepting)
    fail("AlreadyTerminal", "Execution is no longer accepting signals");
  box.order.push(message.id);
  const detaching = box.detaching;
  const operation = (async () => {
    await box.ready;
    await detaching;
    if (!box.accepting)
      fail("AlreadyTerminal", "Execution is no longer accepting signals");
    if (box.frame) {
      await acceptSignal(context, box.frame, message, persist);
    } else {
      const next = box.offline.then(async () => {
        if (!box.accepting)
          fail("AlreadyTerminal", "Execution is no longer accepting signals");
        if (box.frame) await acceptSignal(context, box.frame, message, persist);
        else await acceptSuspended(context, box, message, persist);
      });
      box.offline = next.catch(() => {});
      await next;
    }
  })().catch((error) => {
    box.order = box.order.filter((id) => id !== message.id);
    const info = errorInfo(error);
    if (info.code !== "Cancelled") {
      box.failure ??= error;
      context.runtime.report(info, {
        streamId: box.id,
        threadId: box.threadId,
      });
    }
  });
  box.operations.add(operation);
  void operation
    .finally(() => box.operations.delete(operation))
    .catch(() => {});
}

/** Drain accepted writes before releasing the frame's ownership lease. */
export async function detachSignals(
  frame: ExecutionFrame,
  release: () => Promise<void>,
): Promise<void> {
  const box = frame.signals;
  if (!box) return release();
  if (!frame.admitted)
    box.reject(
      new TessarError("InvalidTransition", "Original input was not admitted"),
    );
  let finish!: () => void;
  const pending = [...box.operations];
  box.detaching = new Promise<void>((done) => {
    finish = done;
  });
  try {
    await Promise.allSettled(pending);
    box.frame = undefined;
    await release();
  } finally {
    box.detaching = undefined;
    finish();
  }
}

export async function acceptSignal(
  context: ExecutionContext,
  frame: ExecutionFrame,
  message: MessageData,
  persist: boolean,
): Promise<void> {
  const box = frame.signals!;
  if (frame.sink.controller.signal.aborted)
    fail("Cancelled", "Execution is cancelled");
  if (!persist) {
    box.pending.push(message);
    return;
  }
  await context.commit(frame, "ExecutionTransition", () => {
    if (!frame.cp.execution) fail("AlreadyTerminal", "Execution already ended");
    frame.cp.execution.pendingSignals = [
      ...(frame.cp.execution.pendingSignals ?? []),
      message,
    ];
  });
}

async function acceptSuspended(
  context: ExecutionContext,
  box: Mailbox,
  message: MessageData,
  persist: boolean,
): Promise<void> {
  const backend = box.runtime.backend;
  const lease = await backend.ownership.acquire({
    threadId: box.threadId,
    ownerToken: context.ids.next("owner"),
    ttlMs: 30000,
  });
  try {
    const head = await backend.threads.get(box.threadId);
    if (!head || head.activeStreamId !== box.id)
      fail("AlreadyTerminal", "Execution is no longer current");
    const cp = (await backend.checkpoints.get(head.currentCheckpointId))!;
    if (!cp.execution?.pendingInterruptId)
      fail("RecoveryRequired", "Recover execution before delivering signal");
    if (!persist) {
      box.pending.push(message);
      return;
    }
    const checkpoint = structuredClone(cp);
    checkpoint.id = context.ids.next("checkpoint");
    checkpoint.parentCheckpointId = cp.id;
    checkpoint.revision++;
    checkpoint.createdAt = context.clock.now();
    checkpoint.cause = "ExecutionTransition";
    checkpoint.execution!.pendingSignals = [
      ...(cp.execution.pendingSignals ?? []),
      message,
    ];
    await new CommitCoordinator(backend).commit(
      {
        commitId: context.ids.next("commit"),
        threadId: box.threadId,
        expectedRevision: cp.revision,
        checkpoint,
        records: [],
      },
      lease,
    );
  } finally {
    await backend.ownership.release(lease);
  }
}

async function settled(box: Mailbox): Promise<void> {
  while (box.operations.size) await Promise.allSettled([...box.operations]);
  if (box.failure !== undefined) throw box.failure;
}

/** Share suspended ownership with resume/recovery instead of racing their leases. */
export function attachSignals(
  context: ExecutionContext,
  threadId: string,
  prepare: () => Promise<ExecutionFrame>,
): Promise<ExecutionFrame> {
  const attach = async () => {
    const frame = await prepare();
    bindSignals(context, frame);
    return frame;
  };
  const box = findSignalTarget(context.agent, { threadId });
  if (!box || box.frame) return attach();
  const pending = box.offline.then(attach);
  box.offline = pending.then(
    () => {},
    () => {},
  );
  return pending;
}

export async function applySignals(
  frame: ExecutionFrame,
  context: LoopContext,
): Promise<boolean> {
  const box = frame.signals;
  if (!box) return false;
  await settled(box);
  const durable = [...(frame.cp.execution?.pendingSignals ?? [])];
  const transient = box.pending.slice();
  if (!durable.length && !transient.length) return false;
  const values = new Map(
    [...durable, ...transient].map((message) => [message.id, message]),
  );
  const order = [...values.keys()]
    .filter((id) => !box.order.includes(id))
    .concat(box.order);
  const ids = new Set(durable.map((message) => message.id));
  const prepared: MessageData[] = [],
    temporary: TransientMessage[] = [];
  let after = frame.cp.state.messages.at(-1)?.id ?? null;
  for (const id of order) {
    const message = values.get(id);
    if (!message) continue;
    const value = await context.prepareMessage(frame, message);
    if (ids.has(id)) {
      prepared.push(value);
      after = value.id;
    } else temporary.push({ after, message: value });
  }
  await context.commit(frame, "MessageCommitted", () => {
    frame.cp.state = {
      ...frame.cp.state,
      messages: [...frame.cp.state.messages, ...prepared],
    };
    frame.cp.execution!.pendingSignals = (
      frame.cp.execution!.pendingSignals ?? []
    ).filter((message) => !ids.has(message.id));
  });
  box.applied.push(...temporary);
  box.pending.splice(0, transient.length);
  box.order = box.order.filter((id) => !values.has(id));
  for (const message of prepared)
    await context.hook(frame, "message.committed", {
      message,
      checkpointId: frame.cp.id,
    });
  return true;
}

export function signalMessages(frame: ExecutionFrame): readonly MessageData[] {
  const messages: MessageData[] = [];
  const overlays = frame.signals?.applied ?? [];
  messages.push(
    ...overlays
      .filter((entry) => entry.after === null)
      .map((entry) => entry.message),
  );
  for (const message of frame.cp.state.messages) {
    messages.push(message);
    messages.push(
      ...overlays
        .filter((entry) => entry.after === message.id)
        .map((entry) => entry.message),
    );
  }
  return messages;
}

/** Close acceptance atomically with the final pending-input check. */
export async function closeSignals(
  frame: ExecutionFrame,
  completed: boolean,
): Promise<boolean> {
  const box = frame.signals;
  if (!box) return true;
  await settled(box);
  if (
    completed &&
    ((frame.cp.execution?.pendingSignals?.length ?? 0) || box.pending.length)
  )
    return false;
  box.accepting = false;
  return true;
}

export async function clearSignals(agent: Agent): Promise<void> {
  const entries = [...(mailboxes.get(agent)?.values() ?? [])];
  for (const box of entries) box.accepting = false;
  await Promise.allSettled(entries.map(settled));
  mailboxes.delete(agent);
}
