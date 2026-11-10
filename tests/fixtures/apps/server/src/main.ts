import { Hono } from "hono";
import { createAdaptorServer } from "@hono/node-server";
import { TessarServer } from "@tessar/server/hono";
import type { Server } from "node:http";
import Database from "libsql";
import { appendFileSync } from "node:fs";
import { z } from "zod";
import { Agent, Controller, AssistantMessage, MessageCodec, createTool, defineInterruption, ToolDecision, turn } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { LibsqlStoragePlugin } from "@tessar/libsql";
import { Tessar, registerRoute } from "@tessar/server";

const database = process.env.TESSAR_FIXTURE_DB ? new Database(process.env.TESSAR_FIXTURE_DB) : undefined;
const model = new ScriptedProvider(process.env.TESSAR_FIXTURE_SUSPEND && !process.env.TESSAR_FIXTURE_RESUMED ? [{ response: {
  message: MessageCodec.encode(new AssistantMessage([{ type: "tool-call", name: "work", toolCallId: "work-call", arguments: {} }])),
} }] : [{ text: "server fixture answer" }, { text: "second answer" }]);
const approval = defineInterruption({ id: "continue", version: 1,
  response: { jsonSchema: { type: "boolean" }, parse(value) { if (typeof value !== "boolean") throw Error("Expected boolean"); return value; } },
  resolve: () => ToolDecision.allow(),
});
const controller = new Controller({ id: "fixture", agent: new Agent({ id: "assistant", model }),
  plugins: process.env.TESSAR_FIXTURE_FAIL ? [{ id: "failure", setup() { throw new Error("fixture initialization failure"); } }] :
    [...(database ? [new LibsqlStoragePlugin({ database })] : []), ...(process.env.TESSAR_FIXTURE_SUSPEND ? [{
      id: "approval", setup(context: import("@tessar/core").PluginContext) {
        context.interruptions.register(approval);
        context.tools.register(createTool({ name: "work", description: "Persist one effect", schema: z.object({}),
          execute() { appendFileSync(process.env.TESSAR_FIXTURE_EFFECT!, "effect\n"); return "done"; } }));
        context.hook(turn.decision, (event, execution) => { if (event.payload.hadTools) return execution.suspend(approval, {}); });
      },
    }] : [])],
});
const tessar = new Tessar({ controllers: [controller], server: {
  port: Number(process.env.TESSAR_FIXTURE_PORT ?? 0),
  routes: [registerRoute("/calls", { method: "GET", handler: c => c.json({ count: model.calls.length }) })],
} });

const app = new Hono();
const adapter = new TessarServer({ app, tessar });
let listener: Server | undefined;
try {
  await adapter.init();
  listener = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false }) as Server;
  await new Promise<void>((resolve, reject) => {
    listener!.once("error", reject);
    listener!.listen(tessar.server.port, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (address && typeof address !== "string") console.log(`Tessar listening at http://127.0.0.1:${address.port}`);
} catch (error) {
  console.error(error); process.exitCode = 1;
  await adapter.shutdown(); await tessar.shutdown();
}
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try {
    await adapter.shutdown();
    if (listener?.listening) await new Promise<void>((resolve, reject) => {
      listener!.close(error => error ? reject(error) : resolve()); listener!.closeAllConnections();
    });
    await tessar.shutdown();
  } finally { database?.close(); }
}
process.stdin.on("data", () => { void close(); });
process.stdin.on("end", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
