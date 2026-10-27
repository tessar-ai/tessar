import { text } from "../../src/events/type.js";
import { expect, it } from "vitest";
import { streamModel } from "../../src/models/stream.js";
import type { ModelAdapter, ModelChunk } from "../../src/models/contract.js";
import { buildInstruction } from "../../src/instructions/instruction.js";
import { AssistantMessage } from "../../src/messages/message.js";
const ref = { providerId: "fixture", modelId: "model" };
const request = {
  model: ref,
  instructions: buildInstruction([]),
  messages: [],
  tools: [],
};
const identity = { messageId: "answer", partId: "text", partIndex: 0 };
const start = {
  type: "text.start",
  ...identity,
  startedAt: "2026-10-26T00:00:00.000Z",
  boundary: "observed",
} as const;
function adapter(chunks: readonly any[]): ModelAdapter {
  return {
    ref,
    validate() {},
    async *stream() {
      yield* chunks;
    },
  };
}
it("closes open parts on early consumer return without requiring another read", async () => {
  const observed: ModelChunk[] = [];
  for await (const _ of streamModel(
    adapter([start]),
    request,
    { signal: new AbortController().signal },
    (chunk) => {
      observed.push(chunk);
    },
  ))
    break;
  expect(observed.map((chunk) => chunk.type)).toEqual([
    "text.start",
    "text.end",
  ]);
  expect(observed.at(-1)).toMatchObject({
    status: "interrupted",
    text: "",
    ...identity,
  });
});
it("keeps a received complete response successful when cancellation arrives after it", async () => {
  const abort = new AbortController();
  const source: ModelAdapter = {
    ref,
    validate() {},
    async *stream() {
      yield {
        type: "response",
        response: { message: new AssistantMessage("done") },
      };
      abort.abort(Error("after response"));
    },
  };
  const chunks: ModelChunk[] = [];
  for await (const chunk of streamModel(source, request, {
    signal: abort.signal,
  }))
    chunks.push(chunk);
  expect(chunks).toHaveLength(1);
});
it.each(
  [
    [{ type: "text.delta", ...identity, delta: "bad" }],
    [start, { ...start, partId: "other", partIndex: 0 }],
    [
      start,
      {
        type: "response",
        response: { message: new AssistantMessage("done", { id: "changed" }) },
      },
    ],
    [
      start,
      {
        type: "text.end",
        ...identity,
        status: "completed",
        text: "done",
        startedAt: start.startedAt,
        endedAt: start.startedAt,
        boundary: "observed",
      },
      { type: "text.delta", ...identity, delta: "late" },
    ],
  ].map((chunks) => ({ chunks })),
)("rejects invalid provider lifecycle $chunks", async ({ chunks }) => {
  await expect(async () => {
    for await (const _ of streamModel(adapter(chunks), request, {
      signal: new AbortController().signal,
    })) {
    }
  }).rejects.toMatchObject({ code: "InvalidModelStream" });
});
