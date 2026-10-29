import { appendFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { Agent, buildInstruction, Controller, type RuntimeState, type Stream } from "@tessar/core";
import { OpenAIProvider } from "@tessar/openai";
import { LoggerPlugin } from "@tessar/plugins/logger";

function formatState(state: RuntimeState): string {
  const lines: string[] = [];

  for (const message of state.messages) {
    const name = message.role === "tool"
      ? state.tools.find(tool => tool.toolCallId === message.toolCallId)?.name
      : undefined;
    lines.push(`\n${message.role.toUpperCase()}${name ? ` (${name})` : ""}`);

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

  if (state.tools.length) lines.push("\nTOOLS");
  for (const tool of state.tools) {
    lines.push(`${tool.name}: ${tool.status}`);
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
  // Redirected output receives one final transcript instead of every snapshot.
  if (!process.stdout.isTTY) return;
  if (!screenOpen) {
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    screenOpen = true;
  }
  // The alternate screen keeps repeated frames out of the main scrollback.
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

const openrouter = new OpenAIProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: process.env.OPENROUTER_MODEL || "openrouter/free",
  baseURL: "https://openrouter.ai/api/v1",
  api: "chat-completions",
});

const systemPrompt = buildInstruction([
  { id: "base", order: 0, content: "You are a Tessar Agent built using the Tessar SDK, utilizing the OpenAI protocol to connect to the provider OpenRouter." },
  { id: "persona", order: 10, content: "Your role is that of a partner who supports users. Provide direct, concise, yet comprehensive responses." },
]);

const agent = new Agent({
  id: "assistant",
  model: openrouter,
  instructions: systemPrompt,
});

const controller = new Controller({
  id: "controller",
  agent,
  plugins: [new LoggerPlugin({
    // Keep structured logs separate from the terminal interface.
    write: (entry) => appendFile("tessar.log", JSON.stringify(entry) + "\n"),
  })],
});

let activeStream: Stream | undefined;
const onInterrupt = (): void => {
  process.exitCode = 130;
  activeStream?.abort("Interrupted by user");
};
process.once("SIGINT", onInterrupt);

try {
  await controller.initialize();
  activeStream = agent.stream("Introduce yourself");
  for await (const event of activeStream) {
    if (event.type === "state_changed") render(event.payload.state);
  }
} finally {
  process.off("SIGINT", onInterrupt);
  try {
    await controller.dispose();
  } finally {
    finishRender();
  }
}
