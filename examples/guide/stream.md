# Streaming with `agent.stream()`

[All guides](README.md) · Next: [Controller and Session](sessions.md)

> **Packages:** `@tessar/core`, `@tessar/openai`, `zod` ·

Learn how to build an agent with a custom tool and consume its execution as a stream of typed events: reasoning tokens, answer tokens, tool calls, and token usage.

**What you'll build:** a weather agent that calls a tool, streams its reasoning separately from its final answer, and reports token usage.

## Installation

npm
```bash
npm install @tessar/core @tessar/openai zod
```
pnpm
```bash
pnpm add @tessar/core @tessar/openai zod
```

## Environment variables

Follow the [application setup](README.md), then use these variables in `.env`
for this OpenRouter example. Combine the Provider, Tool, Instructions and
`runStream` blocks below into `stream.ts`, then run
`node --env-file=.env stream.ts`. The override examples are optional alternatives.

```bash
OPENROUTER_API_KEY=<your-key>
OPENROUTER_MODEL=<your-model>
```

## Overview

| Step | Concept | API |
| :--- | :--- | :--- |
| 1 | Connect a model | `OpenAIProvider` |
| 2 | Define a tool | `createTool` |
| 3 | Compose instructions and create the agent | `buildInstruction`, `Agent` |
| 4 | Consume events | `agent.stream()` |

---

## Provider

`OpenAIProvider` wraps the OpenAI SDK and implements the `ModelAdapter` interface that `Agent` requires. It manages the HTTP client, model identity, request defaults, and the streaming protocol.

By default, `OpenAIProvider` uses the **Responses API** (`/v1/responses`). For the Chat Completions example below, explicitly select `api: "chat-completions"`. Choose the protocol supported by your endpoint; a compatible base URL alone does not select it.

| Endpoint | `api` value |
| :--- | :--- |
| OpenAI (default) | `"responses"` (or omit) |
| An endpoint using Chat Completions | `"chat-completions"` |

The `baseURL` overrides the default `https://api.openai.com/v1` endpoint. The `model` string is sent directly to the provider, so use the exact model identifier your provider expects (e.g. `"openrouter/free"`, `"google/gemini-2.5-flash"`, `"openai/gpt-4o-mini"`).

```ts
import { OpenAIProvider } from "@tessar/openai";

const model = new OpenAIProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: process.env.OPENROUTER_MODEL!,
  baseURL: "https://openrouter.ai/api/v1",
  api: "chat-completions",
});
```

You can also pass any additional OpenAI SDK options (e.g. `timeout`, `maxRetries`, `defaultHeaders`) as top-level fields. Tessar separates client configuration from request body parameters automatically.

---

## Tool

`createTool` defines a function the LLM can invoke during execution. It takes four required fields:

- **`name`**: unique identifier sent to the model as the function name.
- **`description`**: tells the model when and why to call this tool.
- **`schema`**: a `zod` schema defining the expected input parameters. Tessar calls `z.toJSONSchema()` internally to generate the JSON Schema the model sees.
- **`execute`**: the function that runs when the model calls the tool. It receives the validated (zod-parsed) input and must return a JSON-serializable value or a `ToolMessage`. Returning `undefined` throws an error. Async functions are fully supported.

The tool below fetches live weather data from [wttr.in](https://wttr.in), a free API that requires no authentication. The `?format=3` query parameter returns a single-line summary.

```ts
import { createTool } from "@tessar/core/tool";
import { z } from "zod";

const weatherTool = createTool({
  name: "getWeather",
  description: "Get the current weather for a city.",
  schema: z.object({
    location: z.string().describe("City name, e.g. 'Tokyo'"),
  }),
  execute: async ({ location }) => {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=3`);
    if (!res.ok) throw Error(`Weather request failed: ${res.status}`);
    return { weather: (await res.text()).trim() };
  },
});
```

Tools registered via `tools: { weatherTool }` in the `Agent` constructor are available for every execution. Tool names must be unique across both constructor tools and plugin-registered tools. You can optionally limit concurrent tool executions with `tools: { concurrency: 4, weatherTool }`.

---

## Instructions and Agent

### `buildInstruction`

`buildInstruction` composes a system prompt from multiple independent sections. Each section has:

- **`id`**: a unique identifier for the section (useful when plugins need to reference or override specific parts).
- **`content`**: the instruction text sent to the model.
- **`order`**: controls the position in the final prompt. Lower values come first. Sections with the same `order` are sorted by `id` as a tiebreaker.

This is preferable to a single monolithic string because plugins can append their own sections (e.g. skill descriptions, safety rules) without modifying existing content.

### `new Agent`

`Agent` is the core execution unit. It owns the model, instructions, tools, limits, and the agent loop. Required fields:

- **`id`**: identifies this agent in logs, state, and multi-agent setups.
- **`model`**: the `ModelAdapter` instance (here, `OpenAIProvider`).

Optional fields include `instructions`, `tools`, and `limits` (e.g. `maxToolCalls`, `maxTurns` to cap execution).

```ts
import {
  Agent, buildInstruction,
  message as messageEvents, tool as toolEvents, stream as streamEvents,
} from "@tessar/core";

const instructions = buildInstruction([
  { id: "base", order: 0, content: "You are a concise assistant." },
  { id: "tools", order: 10, content: "Use getWeather when asked about weather." },
]);

const agent = new Agent({
  id: "weather-agent",
  model,
  instructions,
  tools: { weatherTool },
});
```

The `Agent` does not require a `Controller` to run. Calling `agent.stream()` or `agent.generate()` directly creates independent executions with automatic per-execution cleanup. Use a `Session` when you need a continuing multi-turn conversation with persistent thread state.

---

## Consuming the stream

`agent.stream(prompt)` accepts a string, a single `MessageData`, or an array of `MessageData`. It returns a `Stream`, an `AsyncIterable<StreamEvent>` that yields events as the execution progresses. Check `event.type` to narrow its payload, using the same event constants and syntax as `session.subscribe()`.

### Event lifecycle

A typical stream with tool calling goes through this flow:

```text
input.received → stream.started
  → turn.start (turn 0)
    → model.start → message.delta (reasoning + text) → model.end
    → tool.start → tool.end
  → turn.end
  → turn.start (turn 1)
    → model.start → message.delta (reasoning + text) → model.end
  → turn.end
→ stream.end
```

In turn 0, the model reads the prompt, reasons, and decides to call a tool. In turn 1, the model receives the tool result and generates the final answer.

### Key events

| Event | When it fires | Payload |
| :--- | :--- | :--- |
| `"message.delta"` | Each streamed content fragment | `delta` (the text chunk), `partKind` (`"reasoning"` or `"text"`), `partId`, `messageId` |
| `"tool.start"` | Model requested a tool call, execution begins | `toolCallId`, `toolExecutionId`, `startedAt` |
| `"tool.end"` | Tool result was published | `status` (`"succeeded"` / `"failed"`), `result.content`, `startedAt`, `endedAt` |
| `"stream.end"` | Entire execution completed | `status`, `usage.metrics`, `output`, `startedAt`, `endedAt` |
| `"stream.error"` | Execution failure or consumer delivery failure | `error`, `target` (`"execution"` / `"consumer"`), available record times |

Every event envelope has `timestamp`, the publication time. Lifecycle payloads
for Stream, Turn, model and tool carry their recorded `startedAt` and, on completion
or failure, `endedAt`; unavailable legacy times may be absent. These can precede
publication after storage commits or ordered parallel-tool result delivery.
`stream.error` also reaches plugin hooks. A `target: "consumer"` error detaches
an overflowing consumer without cancelling the Agent; it is not execution failure.

### Separating reasoning from the answer

When the provider exposes reasoning content, deltas distinguish it using `partKind`:

- `"reasoning"`: reasoning content exposed by the endpoint, which may be a summary or may be absent.
- `"text"`: the final user-facing answer.

Without filtering, both streams print interleaved into a single unreadable block. The code below tracks `currentMode` to print section headers (`[Reasoning]` / `[Answer]`) only on transitions.

### Handling empty text tokens before tool calls

Before emitting a tool call, many models flush a few empty whitespace or newline tokens with `partKind: "text"`. Without the `delta.trim().length === 0` guard, a premature `[Answer]` label appears before `[Tool Call]`.

```ts
async function runStream(prompt: string) {
  console.log(`Prompt: "${prompt}"`);
  const stream = agent.stream(prompt);

  let currentMode: "reasoning" | "text" | null = null;

  for await (const event of stream) {
    if (event.type === toolEvents.start) {
      currentMode = null;
      console.log(`\n\n[Tool Call] Fetching data...`);
    } else if (event.type === toolEvents.end) {
      console.log(`[Tool Result]`, event.payload.result.content);
    } else if (event.type === messageEvents.delta) {
      const { partKind, delta } = event.payload;

      if (partKind === "reasoning") {
        if (currentMode !== "reasoning") {
          if (delta.trim().length === 0) continue;
          currentMode = "reasoning";
          process.stdout.write("\n[Reasoning]\n");
        }
        process.stdout.write(delta);
      } else if (partKind === "text") {
        if (currentMode !== "text") {
          if (delta.trim().length === 0) continue;
          currentMode = "text";
          process.stdout.write("\n\n[Answer]\n");
        }
        process.stdout.write(delta);
      }
    } else if (event.type === streamEvents.error) {
      throw Error(event.payload.error.message);
    } else if (event.type === streamEvents.end) {
      const { inputTokens, outputTokens, reasoningOutputTokens, totalTokens } =
        event.payload.usage.metrics;
      console.log("\n\n[Done]");
      console.log(
        `Tokens: in=${inputTokens?.knownTotal ?? "unavailable"}, ` +
          `out=${outputTokens?.knownTotal ?? "unavailable"} ` +
          `(reasoning: ${reasoningOutputTokens?.knownTotal ?? "unavailable"}), ` +
          `total=${totalTokens?.knownTotal ?? "unavailable"}`
      );
    }
  }
}

await runStream("What is the weather in Vietnam right now?");
```

### Token usage breakdown

At `stream.end`, `payload.usage.metrics` provides per-metric summaries across all model attempts in the stream. Each metric has:

- `knownTotal`: the accumulated count, or `null` if the provider didn't report it.
- `coverage`: `"complete"` if all attempts reported this metric, `"partial"` or `"unavailable"` otherwise.

Available metrics: `inputTokens`, `outputTokens`, `reasoningOutputTokens`, `totalTokens`, `cacheReadInputTokens`, `cacheWriteInputTokens`, `uncachedInputTokens`.

## Overriding the model per call

`agent.stream(input, options)` and `agent.generate(input, options)` take the input first and per-call options second. Options override the agent's default model configuration for that execution only; the agent itself is unchanged.

| Option | Effect |
| :--- | :--- |
| `modelOptions` | Overrides request settings for this call. Nested option objects are **replaced**, not merged. Omitted settings are left to the SDK defaults. |
| `model` (string) | Switches the model identifier and keeps the agent's default connection (API key, `baseURL`). |
| `model` (model instance) | Uses the instance's own connection, e.g. a different `OpenAIProvider`. |

```ts
// Same connection, different model and request settings
const stream = agent.stream("What is the weather in Hanoi?", {
  model: process.env.OPENROUTER_ALTERNATE_MODEL!,
  modelOptions: { 
    reasoning_effort: "high",
  },
});

// A different connection: the agent uses OpenRouter (Chat Completions),
// but this call goes to OpenAI directly (Responses API)
const openai = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: process.env.OPENAI_MODEL!,
});

const stream2 = agent.stream("What is the weather in Hanoi?", { model: openai });
```

---

## Example output

> Output varies by model and provider.

```text
Prompt: "What is the weather in Vietnam right now?"

[Reasoning]
The user asks "What is the weather in Vietnam right now?" We need to get weather. The tool getWeather takes a location: city name. But the user asks "Vietnam", which is a country, not a city. We might need to choose a city in Vietnam, maybe the capital Hanoi, or ask for clarification. The instruction says: "Use getWeather when asked about weather." So we should call getWeather. Probably use "Hanoi". Let's do that.

[Tool Call] Fetching data...
[Tool Result] [ { type: 'data', data: { weather: 'Hanoi: 🌦️  +30 C' } } ]

[Reasoning]
The user asked for the weather in Vietnam right now. I called getWeather with location "Hanoi" (a major city in Vietnam) and got "Hanoi: 🌦️ +30°C". I should share that.

[Answer]
The current weather in Hanoi, Vietnam is **+30°C** with partly cloudy conditions (🌦️).

[Done]
Tokens: in=694, out=325 (reasoning: 269), total=1019
```

---

## Next steps

- Use `agent.generate()` when you only need the final result instead of a live event stream.
- Use a `Session` for multi-turn conversations with persistent thread state.
- Extend the agent with plugins that register their own tools and instruction sections.
