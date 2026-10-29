import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { Agent, buildInstruction, Controller, type RuntimeState, type Session } from "@tessar/core";
import { OpenAIProvider } from "@tessar/openai";
import { createTool } from "@tessar/core/tool";
import { z } from "zod";
import { FileTransport, LoggerPlugin, logGroup } from "@tessar/plugins/logger";
import {
  OpenTelemetryPlugin, LangfuseAdapter, ArizeAdapter,
  TraceloopAdapter, type TraceAdapter,
} from "@tessar/opentelemetry";

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

// Enable each Cloud destination once all of its required environment variables exist.
// See .env.telemetry.example; copy values into .env without replacing provider keys.
const destinations: { name: string; adapter: TraceAdapter }[] = [];
const skipped: string[] = [];

if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
  destinations.push({ name: "Langfuse", adapter: new LangfuseAdapter() });
} else skipped.push("Langfuse: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY");

if (process.env.ARIZE_API_KEY && process.env.ARIZE_SPACE_ID && process.env.ARIZE_PROJECT_NAME) {
  destinations.push({ name: "Arize", adapter: new ArizeAdapter() });
} else skipped.push("Arize: ARIZE_API_KEY, ARIZE_SPACE_ID, ARIZE_PROJECT_NAME");

if (process.env.TRACELOOP_API_KEY) {
  destinations.push({ name: "Traceloop", adapter: new TraceloopAdapter() });
} else skipped.push("Traceloop: TRACELOOP_API_KEY");

if (!destinations.length) {
  throw new Error("Configure at least one tracing destination in .env. See .env.telemetry.example.\n" + skipped.join("\n"));
}

// Reuse the application's OpenRouter credentials.
const provider = new OpenAIProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: process.env.OPENROUTER_MODEL || "openrouter/free",
  baseURL: "https://openrouter.ai/api/v1",
  api: "chat-completions",
});

const systemPrompt = buildInstruction([
  {
    id: "base",
    order: 0,
    content:
      "You are a Tessar Agent built using the Tessar SDK, utilizing the OpenAI protocol to connect to the provider OpenRouter.",
  },
  {
    id: "persona",
    order: 10,
    content:
      "Your role is that of a partner who supports users. Provide direct, concise, yet comprehensive responses.",
  },
]);

const timeTool = createTool({
  name: "get_current_time",
  description: "Get the real current date and time in an IANA timezone. Call this first to resolve today before fetching weather.",
  schema: z.object({
    timeZone: z.string().default("Asia/Ho_Chi_Minh"),
  }),
  execute: ({ timeZone }) => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
    const date = ["year", "month", "day"]
      .map(type => parts.find(part => part.type === type)!.value).join("-");
    return {
      date,
      timeZone,
      utc: now.toISOString(),
      local: new Intl.DateTimeFormat("vi-VN", {
        timeZone, dateStyle: "full", timeStyle: "long",
      }).format(now),
    };
  },
});

const weatherTool = createTool({
  name: "get_weather",
  description: "Fetch Open-Meteo daily weather forecast for coordinates and a YYYY-MM-DD date. For today's weather, first use get_current_time and pass its date and timezone here.",
  schema: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    date: z.iso.date(),
    timeZone: z.string().default("Asia/Ho_Chi_Minh"),
  }),
  execute: async ({ latitude, longitude, date, timeZone }, context) => {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({
      latitude: String(latitude), longitude: String(longitude),
      timezone: timeZone, start_date: date, end_date: date,
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max",
    }).toString();
    const response = await fetch(url, {
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) {
      throw new Error(`Open-Meteo HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    const forecast = z.object({
      timezone: z.string(),
      daily_units: z.record(z.string(), z.string()),
      daily: z.object({
        time: z.array(z.string()).length(1),
        weather_code: z.array(z.number().nullable()).length(1),
        temperature_2m_max: z.array(z.number().nullable()).length(1),
        temperature_2m_min: z.array(z.number().nullable()).length(1),
        precipitation_probability_max: z.array(z.number().nullable()).length(1),
        precipitation_sum: z.array(z.number().nullable()).length(1),
        wind_speed_10m_max: z.array(z.number().nullable()).length(1),
      }),
    }).parse(await response.json());
    return { source: "Open-Meteo", latitude, longitude, ...forecast };
  },
});

const agent = new Agent({
  id: "session-assistant",
  model: provider,
  tools: { get_current_time: timeTool, get_weather: weatherTool },
  instructions: systemPrompt
});

const controller = new Controller({
  id: "session-demo",
  agent,
  plugins: [
    new LoggerPlugin({
      level: "info",
      transports: [new FileTransport({
        path: "./logs/session.log",
        groupBy: logGroup.session,
      })],
    }),
    new OpenTelemetryPlugin({
      serviceName: "tessar-implement",
      tags: ["cloud-test", "session"],
      adapters: destinations.map(destination => destination.adapter),
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
  await session.thread.create({ title: "Today weather: time -> forecast -> answer" });
  unsubscribe = session.subscribe(event => {
    if (event.type === "state_changed") render(event.payload.state);
  });
  render(session.state.get());

  if (!interrupted) await ask(session, [
    "Thời tiết hôm nay ở TP.HCM như thế nào? Tọa độ: latitude=10.8231, longitude=106.6297.",
    "Đầu tiên, hãy gọi get_current_time với timeZone=Asia/Ho_Chi_Minh để biết ngày hôm nay.",
    "Sau khi nhận kết quả, mới gọi get_weather với đúng date và timeZone vừa nhận được.",
    "Không gọi hai tool trong cùng một lần trả lời. Hãy chờ kết quả tool thời gian trước.",
    "Cuối cùng trả lời bằng tiếng Việt: ngày tra cứu, nhiệt độ thấp/cao nhất, khả năng mưa và gió; ghi nguồn Open-Meteo.",
    "Chỉ dùng dữ liệu tool trả về, không tự suy đoán số liệu.",
  ].join("\n"));
} finally {
  unsubscribe();
  process.off("SIGINT", onInterrupt);
  try {
    // Flush logs and all configured tracing destinations before exiting.
    await controller.dispose();
  } finally {
    finishRender();
    console.log("Tracing enabled:", destinations.map(destination => destination.name).join(", "));
    if (skipped.length) console.log("Skipped (missing configuration):\n" + skipped.join("\n"));
    if (session) {
      console.log("Session:", session.id);
      const threadId = session.thread.getId();
      console.log("Thread:", threadId);
      if (threadId) {
        console.log("Trace ID:", createHash("sha256").update(threadId).digest("hex").slice(0, 32));
      }
    }
  }
}




