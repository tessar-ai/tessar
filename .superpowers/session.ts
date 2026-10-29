import { stripVTControlCharacters } from "node:util";
import { Agent, Controller, type RuntimeState, type Session } from "@tessar/core";
import { OpenAIProvider } from "@tessar/openai";
import { FileTransport, LoggerPlugin, logGroup } from "@tessar/plugins/logger";
import { LangfusePlugin } from "@tessar/langfuse";

function formatState(state: RuntimeState): string {
  const lines: string[] = [];
  for (const message of state.messages) {
    lines.push(`\n${message.role.toUpperCase()}`);
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          lines.push(part.text);
          break;
        case "reasoning":
          lines.push("[Thinking]", part.text);
          break;
        case "tool-call":
          lines.push(`[Tool call: ${part.name}]`, JSON.stringify(part.arguments, null, 2));
          break;
        case "data":
          lines.push(JSON.stringify(part.data, null, 2));
          break;
        case "image":
        case "audio":
        case "file":
          lines.push(`[${part.type}: ${part.mediaType}]`);
          break;
      }
    }
  }
  for (const tool of state.tools) {
    lines.push(`\n[Tool: ${tool.name}] ${tool.status}`);
    if (tool.progress !== null) lines.push(JSON.stringify(tool.progress, null, 2));
    if (tool.error) lines.push(`Error: ${tool.error.message}`);
  }
  if (state.interrupt) {
    lines.push("\nWAITING FOR INPUT / APPROVAL", JSON.stringify(state.interrupt.payload, null, 2));
  }
  if (state.error) lines.push(`\nERROR: ${state.error.message}`);
  if (state.queuedInputs) lines.push(`\nQueued inputs: ${state.queuedInputs}`);
  lines.push(`\nStatus: ${state.status}`);
  return stripVTControlCharacters(lines.join("\n")).trimStart();
}

let lastFrame = "";
let screenOpen = false;

function render(state: RuntimeState): void {
  const frame = formatState(state);
  if (frame === lastFrame) return;
  lastFrame = frame;
  if (!process.stdout.isTTY) return;
  if (!screenOpen) {
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    screenOpen = true;
  }
  process.stdout.write("\x1b[H\x1b[2J" + frame);
}

function finishRender(): void {
  if (screenOpen) {
    process.stdout.write("\x1b[?1049l\x1b[?25h");
    screenOpen = false;
  }
  if (lastFrame) process.stdout.write(lastFrame + "\n");
  lastFrame = "";
}

// Reuse the OpenRouter and Langfuse credentials from the application's .env.
const provider = new OpenAIProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: process.env.OPENROUTER_MODEL || "openrouter/free",
  baseURL: "https://openrouter.ai/api/v1",
  api: "chat-completions",
});

const agent = new Agent({
  id: "session-assistant",
  model: provider,
});

const controller = new Controller({
  id: "session-demo",
  agent,
  plugins: [
    new LoggerPlugin({
      level: "debug",
      transports: [new FileTransport({
        path: "./logs/session.log",
        groupBy: logGroup.session,
      })],
    }),
    new LangfusePlugin({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL,
    }),
  ],
});

// followUp() acknowledges queued input. This demo helper waits for its answer
// before sending the next question or closing the Controller.
async function ask(session: Session, text: string): Promise<void> {
  let stop = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    stop = session.subscribe(event => {
      if (event.type === "stream.end") resolve();
      if (event.type === "stream.error") reject(new Error(event.payload.error.message));
      if (event.type === "stream.suspended") {
        reject(new Error("Session is waiting for input or approval; respond with session.resume()."));
      }
      // Also handle admission failures that occur before a Stream can start.
      if (event.type === "state_changed" && event.payload.state.error) {
        reject(new Error(event.payload.state.error.message));
      }
    });
  });
  // Observe early rejection while followUp() is still acknowledging input.
  const accepted = session.followUp(text);
  try {
    await Promise.all([accepted, promise]);
  } finally {
    stop();
  }
}

let session: Session | undefined;
let unsubscribe = () => {};
let interrupted = false;
const onInterrupt = (): void => {
  interrupted = true;
  process.exitCode = 130;
  void session?.abort("Interrupted by user").catch(error => console.error(error));
};
process.once("SIGINT", onInterrupt);

try {
  await controller.initialize();
  session = await controller.createSession({ scope: { userId: "demo-user" } });
  await session.thread.create({ title: "Langfuse Session demo" });
  unsubscribe = session.subscribe(event => {
    if (event.type === "state_changed") render(event.payload.state);
  });
  render(session.state.get());

  if (!interrupted) await ask(session, "Tên tôi là Phúc. Hãy nhớ trong cuộc trò chuyện này.");
  if (!interrupted) await ask(session, "Tên tôi là gì?");
} finally {
  unsubscribe();
  process.off("SIGINT", onInterrupt);
  try {
    // Flush logs and buffered Langfuse observations before exiting.
    await controller.dispose();
  } finally {
    finishRender();
    if (session) {
      console.log("Session:", session.id);
      console.log("Thread:", session.thread.getId());
    }
  }
}
