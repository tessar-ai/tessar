#!/usr/bin/env node
import { tool as toolHooks, stream as streamHooks } from "@tessar/core";
import {
  Agent,
  Controller,
  HumanMessage,
  AssistantMessage,
  MessageCodec,
  createTool,
  defineInterruption,
  ToolDecision,
  type Plugin,
  type PluginContext,
} from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { z } from "zod";
import { SqliteStoragePlugin } from "@tessar/sqlite";
import { OpenAIPlugin } from "@tessar/openai";
import { PluginManager } from "@tessar/plugins";
import { resolve, isAbsolute } from "node:path";

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw Error("Missing value for " + name);
  return value;
}
const manager = new PluginManager({
  directory: resolve(option("--plugin-dir") ?? ".tessar"),
  hostUrl: import.meta.url,
});
let controller: Controller | undefined;
try {
  if (args[0] === "plugins") {
    const command = args[1],
      value = args[2]?.startsWith("--") ? undefined : args[2];
    if (command === "list")
      console.log(JSON.stringify(await manager.discover()));
    else if (command === "install" && value) {
      const source =
        isAbsolute(value) || value.startsWith(".") || value.startsWith("file:")
          ? resolve(value.replace(/^file:/, ""))
          : value;
      console.log(
        JSON.stringify({
          installed: await manager.install(source, { name: option("--name") }),
        }),
      );
    } else if (command === "update") {
      await manager.update(value);
      console.log(JSON.stringify({ updated: value ?? "all" }));
    } else if (command === "remove" && value) {
      await manager.remove(value);
      console.log(JSON.stringify({ removed: value }));
    } else
      throw Error(
        "Usage: plugins list|install <source> [--name <package>]|update [package]|remove <package>",
      );
  } else {
    const externalPlugins = await manager.load();
    const filename = option("--db"),
      threadId = option("--thread"),
      interruptId = option("--resume");
    if (interruptId && !threadId) throw Error("--resume requires --thread");
    const approval = args.includes("--approval"),
      live = args.includes("--openai");
    const question = defineInterruption({
      id: "demo.approval",
      version: 1,
      response: {
        jsonSchema: { type: "boolean" },
        parse(value) {
          if (typeof value !== "boolean") throw Error("Boolean required");
          return value;
        },
      },
      resolve: (approved) =>
        approved ? ToolDecision.allow() : ToolDecision.deny("Declined"),
    });
    const scripted = new ScriptedProvider(
      approval && !interruptId
        ? [
            {
              response: {
                message: MessageCodec.encode(
                  new AssistantMessage([
                    {
                      type: "tool-call",
                      toolCallId: "demo-call",
                      name: "echo",
                      arguments: {},
                    },
                  ]),
                ),
              },
            },
            { text: "fixture answer" },
          ]
        : [{ text: "fixture answer" }],
    );
    class DemoToolsPlugin implements Plugin {
      readonly id = "demo.tools";
      setup(tessar: PluginContext): void {
        tessar.tools.register(
          createTool({
            name: "echo",
            description: "Return a demonstration result",
            schema: z.strictObject({}),
            execute: () => "echoed",
          }),
        );
        tessar.interruptions.register(question);
        if (approval)
          tessar.hook(toolHooks.before, (_event, context) =>
            context.suspend(question, {}),
          );
      }
    }
    const plugins: Plugin[] = [new DemoToolsPlugin()];
    if (filename) plugins.push(new SqliteStoragePlugin({ filename }));
    if (live) {
      if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL)
        throw Error("--openai requires OPENAI_API_KEY and OPENAI_MODEL");
      plugins.push(new OpenAIPlugin({ apiKey: process.env.OPENAI_API_KEY }));
    } else {
      class DemoModelPlugin implements Plugin {
        readonly id = "demo.model";
        setup(tessar: PluginContext): void {
          tessar.models.register({
            id: "scripted",
            create: () => scripted,
          });
        }
      }
      plugins.push(new DemoModelPlugin());
    }
    const agent = new Agent({
      id: "cli",
      model: live
        ? { providerId: "openai", modelId: process.env.OPENAI_MODEL! }
        : { providerId: "scripted", modelId: "test" },
    });
    controller = new Controller({
      id: "cli-runtime",
      agent,
      plugins: [...plugins, ...externalPlugins],
    });
    await controller.initialize();
    const session = await controller.createSession({
      scope: { workspace: "demo" },
    });
    const cancel = () => {
      void session
        .abort("SIGINT")
        .catch((error) => console.error(error.message));
    };
    process.on("SIGINT", cancel);
    try {
      const thread = threadId
        ? await session.thread.switch(threadId)
        : await session.thread.create();
      const boundary = new Promise<{
        streamId: string;
        interruptId: string | null;
      }>((resolve, reject) =>
        session.subscribe((event) => {
          if (event.type === streamHooks.suspended)
            resolve({
              streamId: event.streamId!,
              interruptId: event.payload.interrupt.id,
            });
          if (event.type === streamHooks.end)
            resolve({ streamId: event.streamId!, interruptId: null });
          if (event.type === streamHooks.error)
            reject(Error(event.payload.error.message));
        }),
      );
      if (interruptId) await session.resume({ interruptId, value: true });
      else
        await session.followUp(
          new HumanMessage(
            args[0] && !args[0].startsWith("--") ? args[0] : "hello",
          ),
        );
      const end = await boundary,
        record = (await thread.getStream(end.streamId))!,
        snapshot = await thread.snapshot();
      const output = snapshot.state.messages
        .filter(
          (message) =>
            record.outputMessageIds.includes(message.id) &&
            message.role === "assistant",
        )
        .flatMap((message) => message.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const turns = await thread.listTurns(end.streamId);
      let toolCalls = 0;
      for (const turn of turns.items)
        toolCalls += (await thread.listToolExecutions(turn.id)).items.filter(
          (tool) => tool.status === "succeeded",
        ).length;
      console.log(
        JSON.stringify({
          status: record.status,
          threadId: thread.id,
          streamId: record.id,
          interruptId: end.interruptId,
          output,
          toolCalls,
        }),
      );
    } finally {
      process.off("SIGINT", cancel);
    }
  }
} finally {
  try {
    await controller?.dispose();
  } finally {
    manager.dispose();
  }
}
