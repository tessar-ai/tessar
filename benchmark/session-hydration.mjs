import assert from "node:assert/strict";
import { z } from "zod";
import { AssistantMessage, MessageCodec, createTool, stream } from "@tessar/core";
import { AgentHarness } from "@tessar/core/testing";

const HISTORICAL_TOOLS = 20;
const call = (name, id) => ({ type: "tool-call", name, toolCallId: id, arguments: {} });
const response = content => ({ response: { message: MessageCodec.encode(new AssistantMessage(content)) } });
const h = await AgentHarness.create({
  modelScripts: [
    response(Array.from({ length: HISTORICAL_TOOLS }, (_, index) => call("echo", "old-" + index))),
    { text: "finished" },
    response([call("ask", "question")]),
  ],
  tools: {
    echo: createTool({ name: "echo", description: "Fixture", schema: z.object({}), execute: () => "ok" }),
    ask: createTool({ name: "ask", description: "Fixture", schema: z.object({}), execute: (_, context) => context.suspend({ question: "Which?" }) }),
  },
});

function boundary(session, type) {
  return new Promise((resolve, reject) => {
    const off = session.subscribe(event => {
      if (event.type === type) { off(); resolve(); }
      else if (event.type === stream.error) { off(); reject(new Error(event.payload.error.message)); }
    });
  });
}

try {
  const session = await h.controller.createSession();
  await session.thread.create();
  const completed = boundary(session, stream.end);
  await session.followUp("old work");
  await completed;
  const suspended = boundary(session, stream.suspended);
  await session.followUp("ask");
  await suspended;
  const reads = [];
  for (const method of ["listRecords", "page"]) {
    const read = h.backend.executions[method].bind(h.backend.executions);
    h.backend.executions[method] = async (...args) => {
      const result = await read(...args);
      if (args[0] === "tool_executions") {
        const rows = Array.isArray(result) ? result : result.items;
        reads.push({ method, returned: rows.length, jsonBytes: Buffer.byteLength(JSON.stringify(rows)), query: args[2] });
      }
      return result;
    };
  }
  const restored = await h.controller.getSession(session.id);
  assert.ok(restored);
  const state = restored.state.get();
  assert.equal(state.status, "suspended");
  assert.equal(state.tools.length, 1);
  assert.equal(state.tools[0].toolCallId, "question");
  assert.equal(state.tools[0].status, "suspended");
  assert.ok(state.interrupt);
  console.log(JSON.stringify({ node: process.version, historicalTools: HISTORICAL_TOOLS, restoredTools: state.tools.length, reads }, null, 2));
} finally { await h.dispose(); }
