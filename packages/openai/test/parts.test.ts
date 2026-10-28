import { expect, it } from "vitest";
import type OpenAI from "openai";
import { OpenAIAdapter } from "../src/adapter.js";
import { OpenAIChatAdapter } from "../src/chat-adapter.js";
import { streamModel } from "../../core/src/models/stream.js";
import type { ModelChunk } from "@tessar/core";
const ref = { providerId: "fixture", modelId: "fixture" };
const request = {
  model: ref,
  instructions: { sections: [] },
  messages: [],
  tools: [],
};
function client(events: unknown[], api: "chat" | "responses"): OpenAI {
  const endpoint = {
    create: async () =>
      (async function* () {
        yield* events;
      })(),
  };
  return (api === "chat"
    ? { chat: { completions: endpoint } }
    : { responses: endpoint }) as unknown as OpenAI;
}
it("keeps interleaved Responses parts under one message and preserves explicit boundaries", async () => {
  const adapter = new OpenAIAdapter(
    { apiKey: "fixture" },
    ref,
    client(
      [
        { type: "response.created", response: { id: "response" } },
        {
          type: "response.reasoning_summary_part.added",
          item_id: "reason",
          summary_index: 0,
        },
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "reason",
          summary_index: 0,
          delta: "think",
        },
        {
          type: "response.output_text.delta",
          item_id: "answer",
          content_index: 0,
          delta: "reply",
        },
        {
          type: "response.reasoning_summary_part.done",
          item_id: "reason",
          summary_index: 0,
          part: { text: "think" },
        },
        {
          type: "response.content_part.done",
          item_id: "answer",
          content_index: 0,
          part: { type: "output_text", text: "reply" },
        },
        {
          type: "response.completed",
          response: {
            id: "response",
            output: [
              { type: "reasoning", id: "reason", summary: [{ text: "think" }] },
              {
                type: "message",
                id: "answer",
                content: [{ type: "output_text", text: "reply" }],
              },
              {
                type: "function_call",
                id: "call",
                call_id: "tool",
                name: "work",
                arguments: "{}",
              },
            ],
          },
        },
      ],
      "responses",
    ),
  );
  const chunks: ModelChunk[] = [];
  for await (const chunk of streamModel(adapter, request, {
    signal: new AbortController().signal,
  }))
    chunks.push(chunk);
  const parts = chunks.filter(
    (chunk) => chunk.type !== "response" && chunk.type !== "usage",
  );
  expect(new Set(parts.map((part) => part.messageId))).toEqual(
    new Set(["response"]),
  );
  expect(
    parts.findIndex((part) => part.type === "reasoning.end"),
  ).toBeGreaterThan(parts.findIndex((part) => part.type === "text.delta"));
  expect(
    parts
      .filter(
        (part) => part.type === "text.end" || part.type === "reasoning.end",
      )
      .every((part) => part.boundary === "provider"),
  ).toBe(true);
  expect(parts.find((part) => part.type === "tool.call.end")).toMatchObject({
    arguments: {},
    partIndex: 2,
  });
  expect(chunks.at(-1)).toMatchObject({
    response: { message: { id: "response" } },
  });
});
it("buffers fragmented Chat identities and arguments; text does not complete reasoning", async () => {
  const chunk = (delta: object, finish_reason: string | null = null) => ({
    id: "chat",
    choices: [{ index: 0, delta, finish_reason }],
  });
  const adapter = new OpenAIChatAdapter(
    { apiKey: "fixture" },
    ref,
    client(
      [
        chunk({ reasoning_content: "think" }),
        chunk({ content: "reply" }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "to",
              type: "function",
              function: { name: "wo", arguments: '{"a":' },
            },
          ],
        }),
        chunk(
          {
            tool_calls: [
              { index: 0, id: "ol", function: { name: "rk", arguments: "1}" } },
            ],
          },
          "tool_calls",
        ),
      ],
      "chat",
    ),
  );
  const chunks: ModelChunk[] = [];
  for await (const item of streamModel(adapter, request, {
    signal: new AbortController().signal,
  }))
    chunks.push(item);
  expect(
    chunks.find((item) => item.type === "tool.call.start"),
  ).not.toHaveProperty("name");
  expect(chunks.find((item) => item.type === "tool.call.end")).toMatchObject({
    toolCallId: "tool",
    name: "work",
    arguments: { a: 1 },
    boundary: "observed",
  });
  expect(
    chunks.findIndex((item) => item.type === "reasoning.end"),
  ).toBeGreaterThan(
    chunks.findIndex((item) => item.type === "tool.call.start"),
  );
});
