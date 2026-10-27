import type { Agent, AgentResumeOptions, GenerateOutcome } from "../agent.js";
import type { Controller } from "../controller.js";
import { fail, errorInfo } from "../errors.js";
import type { Stream } from "./delivery.js";
import type { ExecutionRuntime } from "./runtime.js";

interface AttachmentState {
  done: Promise<void>;
  finish(): void;
  closed: boolean;
  admitted: boolean;
  abortReason?: string;
  unsubscribe?: () => void;
}
interface Continuation {
  runtime: ExecutionRuntime;
  current?: AttachmentState; // Admission tail, including rejected attempts.
  owner?: AttachmentState; // Last admitted handle owns waiting cancellation.
  canceling?: Promise<void>;
  disposal?: Promise<void>;
}
const runtimes = new WeakMap<Agent, Map<string, Continuation>>();

export function standaloneFor(
  agent: Agent,
  threadId: string,
): ExecutionRuntime | undefined {
  return runtimes.get(agent)?.get(threadId)?.runtime;
}

async function dispose(
  agent: Agent,
  threadId: string,
  entry: Continuation,
): Promise<void> {
  entry.disposal ??= (async () => {
    try {
      await entry.runtime.hooks.dispose();
    } finally {
      entry.current?.unsubscribe?.();
      entry.owner?.unsubscribe?.();
      await entry.runtime.backend.close();
      if (runtimes.get(agent)?.get(threadId) === entry)
        runtimes.get(agent)!.delete(threadId);
    }
  })();
  return entry.disposal;
}

export async function cancelRetained(
  agent: Agent,
  threadId: string,
  reason: string,
  action: (runtime?: ExecutionRuntime) => Promise<void>,
): Promise<void> {
  const entry = runtimes.get(agent)?.get(threadId);
  if (entry?.owner) entry.owner.abortReason = reason;
  await action(entry?.runtime);
  if (entry?.current?.closed) await dispose(agent, threadId, entry);
}

async function cancelWaiting(
  agent: Agent,
  threadId: string,
  entry: Continuation,
  reason: string,
): Promise<void> {
  entry.canceling ??= (async () => {
    await entry.current?.done;
    if (entry.disposal) return entry.disposal;
    try {
      const head = await entry.runtime.backend.threads.get(threadId);
      if (head?.activeStreamId)
        await agent.cancel(threadId, head.activeStreamId, reason);
    } finally {
      await dispose(agent, threadId, entry);
    }
  })();
  return entry.canceling;
}

export function retainStandalone(
  agent: Agent,
  threadId: string,
  runtime: ExecutionRuntime,
) {
  let entries = runtimes.get(agent);
  if (!entries) runtimes.set(agent, (entries = new Map()));
  let entry = entries.get(threadId);
  if (!entry) entries.set(threadId, (entry = { runtime }));
  const retained = entry;
  const ready = entry.current?.done ?? Promise.resolve();
  const { promise: done, resolve: finish } = Promise.withResolvers<void>();
  const state: AttachmentState = {
    done,
    finish,
    closed: false,
    admitted: false,
  };
  entry.current = state;
  return {
    ready,
    admitted(): void {
      retained.owner?.unsubscribe?.();
      retained.owner = state;
      state.admitted = true;
    },
    bind(stream: Stream, signal?: AbortSignal): Stream {
      const abort = stream.abort.bind(stream);
      stream.abort = (reason = "Cancelled") => {
        if (retained.disposal || (state.closed && retained.owner !== state))
          return;
        if (state.closed)
          void cancelWaiting(agent, threadId, retained, reason).catch((error) =>
            runtime.report(errorInfo(error)),
          );
        else {
          state.abortReason = reason;
          abort(reason);
        }
      };
      if (signal) {
        const cancel = () => stream.abort(String(signal.reason ?? "Cancelled"));
        state.unsubscribe = () => signal.removeEventListener("abort", cancel);
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      }
      return stream;
    },
    async cleanup(outcome?: GenerateOutcome): Promise<void> {
      try {
        if (retained.disposal) return;
        if (!state.admitted) {
          state.unsubscribe?.();
          if (!retained.owner) await dispose(agent, threadId, retained);
          return;
        }
        if (retained.owner !== state) return;
        const head = await runtime.backend.threads.get(threadId);
        const waiting =
          outcome?.status === "suspended" ||
          (!!head?.activeStreamId &&
            (await runtime.queries.snapshot(threadId)).execution
              ?.pendingInterruptId);
        if (waiting && !state.abortReason) return;
        if (waiting && head?.activeStreamId)
          await agent.cancel(threadId, head.activeStreamId, state.abortReason);
        await dispose(agent, threadId, retained);
      } finally {
        state.closed = true;
        state.finish();
      }
    },
  };
}

export function resumeAgent(
  agent: Agent,
  options: AgentResumeOptions,
  controller?: Controller,
): Stream {
  controller?.requireReady();
  const entry = runtimes.get(agent)?.get(options.threadId);
  const runtime = controller ?? entry?.runtime;
  if (!runtime)
    fail(
      "ThreadNotFound",
      "Standalone execution is not retained by this Agent",
    );
  const lifecycle = controller
    ? undefined
    : retainStandalone(agent, options.threadId, runtime);
  try {
    const stream = agent.admit(
      {
        kind: "resume",
        threadId: options.threadId,
        interruptId: options.interruptId,
        value: options.value,
        signal: options.signal,
      },
      { kind: "iterator" },
      async () => {
        await lifecycle?.ready;
        if (entry?.canceling || entry?.disposal)
          fail("Cancelled", "Waiting execution was canceled");
        await runtime.queries.requireThread(options.threadId, {
          scope: options.scope,
        });
      },
      runtime,
      lifecycle?.cleanup,
      lifecycle?.admitted,
    );
    return lifecycle?.bind(stream, options.signal) ?? stream;
  } catch (error) {
    void lifecycle
      ?.cleanup()
      .catch((cause) => runtime.report(errorInfo(cause)));
    throw error;
  }
}

export async function closeStandalone(agent: Agent): Promise<void> {
  await Promise.all(
    [...(runtimes.get(agent) ?? [])].map(([id, entry]) =>
      cancelWaiting(agent, id, entry, "Agent shut down"),
    ),
  );
}
