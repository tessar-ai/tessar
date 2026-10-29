import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const result = JSON.parse(await readFile(new URL("arize-check-spans.json", import.meta.url), "utf8"));
const { rows, threadId, otherId } = result;
assert.equal(rows.length, 15);
const roots = rows.filter(row => row.kind === "AGENT");
assert.equal(roots.length, 3);
assert.equal(new Set(roots.map(row => row.context.trace_id)).size, 3);
assert.deepEqual(roots.map(row => row.attributes["session.id"]).sort(), [threadId, threadId, otherId].sort());
for (const row of rows) if (row.parent_id) {
  assert.ok(rows.some(parent => parent.context.trace_id === row.context.trace_id && parent.context.span_id === row.parent_id), "Orphan span " + row.name);
}
const models = rows.filter(row => row.kind === "LLM");
const roles = row => row.attributes["llm.input_messages"].map(message => message["message.role"]);
const followUp = models.find(row => row.attributes["input.value"].includes("Use the earlier result to give advice."));
assert.ok(followUp);
assert.deepEqual(roles(followUp), ["system", "user", "assistant", "tool", "assistant", "tool", "assistant", "user"]);
assert.equal(followUp.attributes["llm.input_messages"].filter(message=>message["message.role"] === "system").length, 1);
const fresh = models.find(row => row.attributes["session.id"] === otherId);
assert.deepEqual(roles(fresh), ["system", "user"]);
const final = models.find(row => row.attributes["output.value"].includes("It is 30 degrees."));
assert.deepEqual(final.attributes["llm.output_messages"][0]["message.contents"].map(part => part["message_content.type"]), ["reasoning", "text"]);
for (const row of rows.filter(row => row.kind === "TOOL")) {
  const parent = rows.find(parent => parent.context.span_id === row.parent_id);
  assert.equal(parent.name, row.name === "get_current_time" ? "turn 1" : "turn 2");
}
console.log(JSON.stringify({ received: rows.length, agentRoots: roots.length, sessionGroups: 2, hierarchy: "valid", fullHistory: "valid", separateThinking: "valid", toolsInCorrectTurns: true, freshThreadHistory: "isolated" }));
