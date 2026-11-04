import Database from "libsql";
import { stream as streamHooks, message as messageHooks } from "@tessar/core";
import { z } from "zod";
import { createLibsqlBackend } from "@tessar/libsql";
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { AgentHarness } from "@tessar/core/testing";
import { AssistantMessage, HumanMessage, MessageCodec, createTool } from "@tessar/core";
import { appendFileSync } from "node:fs";
const filename = process.argv[2]!, participant = process.argv[3]!;
const database = new Database(filename);
database.exec("PRAGMA busy_timeout=5000");
const backend = await createLibsqlBackend({ database });
if (participant.startsWith("crash-")) {
  const harness = await AgentHarness.create({
    backend, plugins: [
      { id: "tools", setup(tessar) { tessar.tools.register(createTool({ name: "write", description: "write", schema: z.object({}), execute: async () => { appendFileSync(filename + ".effects", "write\n"); if (participant === "crash-tool-dispatch") process.exit(0); return "done"; } })); } },
      {
        id: "crash-observer", setup(tessar) {
          tessar.hook(streamHooks.started, event => { writeFileSync(filename + ".execution", JSON.stringify({ threadId: event.threadId, streamId: event.streamId })); });
          tessar.hook(messageHooks.committed, event => { if (participant === "crash-model-result" && event.payload.message.role === "assistant") process.exit(0); });
        }
      }
    ], modelScripts: [{ response: { message: MessageCodec.encode(new AssistantMessage([{ type: "tool-call", toolCallId: "c", name: "write", arguments: {} }])) } }]
  });
  const thread = await harness.createThread();
  await harness.collect(harness.admit({ kind: "input", threadId: thread.id, input: [MessageCodec.encode(new HumanMessage("write"))], model: { providerId: "scripted", modelId: "test" } }));
  throw Error("Expected crash boundary was not reached");
}
writeFileSync(filename + "." + participant + ".ready", "ready");
const deadline = Date.now() + 10000;
while (!existsSync(filename + ".a.ready") || !existsSync(filename + ".b.ready")) {
  if (Date.now() > deadline) throw Error("Other process did not become ready");
  await setTimeout(10);
}
let result: unknown;
try {
  const lease = await backend.ownership.acquire({ threadId: "race-thread", ownerToken: "same-controller/" + participant, ttlMs: 60000 });
  result = { ok: true, lease };
} catch (error) { result = { ok: false, code: (error as { code?: string }).code }; }
writeFileSync(filename + "." + participant + ".result", JSON.stringify(result));
await backend.close();
database.close();
