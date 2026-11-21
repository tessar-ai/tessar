import { expect, it, vi } from "vitest";
import { ExecutionPhase } from "../src/state/schema.js";
import { CommitCoordinator } from "../src/state/commit.js";
import type { RecordEntry } from "../src/state/schema.js";
import type { ToolExecutionRecord } from "../src/trace/records.js";
import { aggregateUsage } from "../src/trace/usage.js";
import { AgentHarness } from "../src/testing/harness.js";

async function toolHistory() {
  const h = await AgentHarness.create();
  const session = await h.controller.createSession();
  const thread = await session.thread.create();
  const previous = await h.checkpoint(thread.id);
  const checkpoint = {
    ...previous, id: "suspended-tools", parentCheckpointId: previous.id, revision: previous.revision + 1,
    execution: {
      streamId: "active", turnId: "active-turn", phase: ExecutionPhase.Suspended,
      modelRef: h.provider.ref, baseInstructions: h.agent.getInstruction(),
      pendingToolExecutionIds: ["active-204"], pendingInterruptId: "question", handlerCursor: null,
      budgets: { turns: 1, modelAttempts: 1, toolCalls: 205, limits: { ...h.agent.limits(), maxToolCalls: 1000 } },
      registryManifest: [],
    },
  };
  const records: RecordEntry[] = [{
    kind: "streams", id: "active", threadId: thread.id,
    data: {
      id: "active", threadId: thread.id, scope: {}, status: "suspended", triggerMessageId: null,
      startedAt: previous.createdAt, endedAt: null, durationMs: null, stopReason: null, error: null,
      outputMessageIds: [], directUsage: aggregateUsage([]),
    },
  }];
  for (const [streamId, count] of [["old", 210], ["active", 205]] as const) {
    for (let index = 0; index < count; index++) {
      const id = streamId + "-" + String(index).padStart(3, "0");
      const tool: ToolExecutionRecord = {
        id, streamId, turnId: streamId + "-turn", scope: {}, toolCallId: id,
        parentToolExecutionId: null, toolName: "ask", arguments: { payload: "x".repeat(100) },
        policyDecision: { decision: "allowed" }, status: id === "active-204" ? "suspended" : "succeeded",
        startedAt: previous.createdAt, endedAt: null, durationMs: null, resultMessageId: null,
        result: null, error: null, idempotencyKey: null,
      };
      records.push({ kind: "tool_executions", id, threadId: thread.id, data: tool });
    }
  }
  records.push({
    kind: "interrupts", id: "question", threadId: thread.id, data: {
      id: "question", threadId: thread.id, streamId: "active", checkpointId: checkpoint.id,
      definitionId: "ask", definitionVersion: 1, pluginId: "tools", payload: { question: "Which?" },
      responseSchema: { type: "string" }, actionRef: null, status: "pending", response: null,
      resolvedDecision: null, resolvedAt: null, createdAt: previous.createdAt, revision: 1,
    }
  });
  const lease = await h.backend.ownership.acquire({ threadId: thread.id, ownerToken: "fixture", ttlMs: 60000 });
  try {
    await new CommitCoordinator(h.backend).commit({
      commitId: "tool-history", threadId: thread.id, expectedRevision: previous.revision, checkpoint, records,
    }, lease);
  } finally { await h.backend.ownership.release(lease); }
  return { h, session, thread, checkpoint, records };
}

it("hydrates every active-stream tool through filtered pages pinned to one checkpoint", async () => {
  const { h, session, thread, checkpoint, records } = await toolHistory();
  try {
    const lists = vi.spyOn(h.backend.executions, "listRecords");
    const read = h.backend.executions.page.bind(h.backend.executions);
    const pages = vi.spyOn(h.backend.executions, "page").mockImplementation(async (...args) => {
      const page = await read(...args);
      if (!args[2].cursor) {
        const lease = await h.backend.ownership.acquire({ threadId: thread.id, ownerToken: "concurrent", ttlMs: 60000 });
        try {
          const last = records.find(record => record.id === "active-204")!;
          await new CommitCoordinator(h.backend).commit({
            commitId: "tool-changed", threadId: thread.id, expectedRevision: checkpoint.revision,
            checkpoint: { ...checkpoint, id: "changed-tools", parentCheckpointId: checkpoint.id, revision: checkpoint.revision + 1 },
            records: [{ ...last, kind: "tool_executions", data: { ...last.data as ToolExecutionRecord, status: "cancelled" } }],
          }, lease);
        } finally { await h.backend.ownership.release(lease); }
      }
      return page;
    });
    const restored = (await h.controller.getSession(session.id))!;
    const state = restored.state.get();
    expect(state.status).toBe("suspended");
    expect(state.interrupt).toMatchObject({ id: "question", status: "pending" });
    expect(state.tools.map(tool => tool.id)).toEqual(Array.from({ length: 205 }, (_, index) => "active-" + String(index).padStart(3, "0")));
    expect(state.tools.at(-1)!.status).toBe("suspended");
    expect(lists).not.toHaveBeenCalled();
    expect(pages).toHaveBeenCalledTimes(2);
    for (const [kind, threadId, query] of pages.mock.calls) {
      expect(kind).toBe("tool_executions");
      expect(threadId).toBe(thread.id);
      expect(query).toMatchObject({ streamId: "active", atCheckpointId: checkpoint.id });
    }
  } finally { await h.dispose(); }
});

it("leaves the previous rendering state intact when loading a later page fails", async () => {
  const { h, session } = await toolHistory();
  try {
    const previous = session.state.get();
    const error = Error("storage failed on page two");
    const read = h.backend.executions.page.bind(h.backend.executions);
    h.backend.executions.page = async (...args) => {
      if (args[2].cursor) throw error;
      return read(...args);
    };
    await expect(session.restoreState()).rejects.toBe(error);
    expect(session.state.get()).toBe(previous);
  } finally { await h.dispose(); }
});

it("does not register a restored handle after Controller shutdown finishes", async () => {
  const { h, session } = await toolHistory();
  const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  const close = h.backend.close.bind(h.backend);
  const closing = vi.spyOn(h.backend, "close").mockResolvedValue();
  const read = h.backend.executions.get.bind(h.backend.executions);
  h.backend.executions.get = async (...args) => { const row = await read(...args); entered.resolve(); await gate.promise; return row; };
  const loading = h.controller.getSession(session.id);
  try {
    await entered.promise; await h.dispose();
    const rejected = expect(loading.then(() => undefined)).rejects.toMatchObject({ code: "Disposed" });
    gate.resolve(); await rejected;
  } finally { gate.resolve(); await loading.catch(() => { }); closing.mockRestore(); await close(); }
});
