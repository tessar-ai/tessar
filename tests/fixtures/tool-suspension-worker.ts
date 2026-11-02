import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  Agent,
  Controller,
  AssistantMessage,
  HumanMessage,
  MessageCodec,
  createTool,
  checkpoint,
  stream,
} from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { LibsqlStoragePlugin } from "@tessar/libsql";
import { z } from "zod";

const [command, filename] = process.argv.slice(2) as [string, string];
const ask = createTool({
  name: "ask",
  description: "Ask",
  schema: z.object({}),
  resumeSchema: z.string().min(1),
  execute: (_input, context) => {
    appendFileSync(filename + ".calls", "execute\n");
    return context.suspend({ question: "Choose" });
  },
  resume: (value) => {
    appendFileSync(filename + ".calls", "resume\n");
    return value;
  },
});
const starting = command === "start" || command === "crash-wait";
const model = new ScriptedProvider(
  starting
    ? [
        {
          response: {
            message: MessageCodec.encode(
              new AssistantMessage([
                {
                  type: "tool-call",
                  toolCallId: "call",
                  name: "ask",
                  arguments: {},
                },
              ]),
            ),
          },
        },
      ]
    : [{ text: "finished" }],
);
const controller = new Controller({
  id: "host",
  agent: new Agent({ id: "assistant", model, tools: { ask } }),
  plugins: [
    new LibsqlStoragePlugin({ filename }),
    {
      id: "crash-boundary",
      setup(tessar) {
        tessar.hook(checkpoint.committed, async (event, context) => {
          const cp = await context.thread?.getCheckpoint(
            event.payload.checkpointId,
          );
          if (command === "crash-answer" && cp?.cause === "Resumed")
            process.exit(0);
          if (
            command === "crash-wait" &&
            cp?.execution &&
            !cp.execution.pendingInterruptId
          ) {
            const requests = await context.thread!.listInterrupts();
            const pending = requests.items.find(
              (r) => r.kind === "tool-result" && r.status === "pending",
            );
            if (pending) {
              writeFileSync(
                filename + ".ids",
                JSON.stringify({
                  sessionId: context.sessionId,
                  threadId: cp.threadId,
                  streamId: cp.execution.streamId,
                  interruptId: pending.id,
                }),
              );
              process.exit(0);
            }
          }
        });
      },
    },
  ],
});
try {
  await controller.initialize();
  const ids = starting
    ? undefined
    : JSON.parse(readFileSync(filename + ".ids", "utf8"));
  const session = starting
    ? await controller.createSession()
    : (await controller.getSession(ids.sessionId))!;
  if (starting) await session.thread.create();
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  session.subscribe(event => {
    if (event.type === stream.error) fail(Error(event.payload.error.message));
    if (event.type === stream.suspended) {
      writeFileSync(
        filename + ".ids",
        JSON.stringify({
          sessionId: session.id,
          threadId: event.threadId,
          streamId: event.streamId,
          interruptId: event.payload.interrupt.id,
        }),
      );
      console.log(
        JSON.stringify({
          status: "suspended",
          payload: event.payload.interrupt.payload,
        }),
      );
      finish();
    }
    if (event.type === stream.end) {
      console.log(
        JSON.stringify({
          status: event.payload.status,
          output: event.payload.output,
        }),
      );
      finish();
    }
  });
  if (starting) await session.followUp(new HumanMessage("ask"));
  else if (command === "recover") await session.recover({ streamId: ids.streamId });
  else await session.resume({ interruptId: ids.interruptId, value: "selected" });
  await done;
} finally {
  await controller.dispose();
}
