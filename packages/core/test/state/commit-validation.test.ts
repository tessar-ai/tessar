import { expect, it, vi } from "vitest";
import { immutable } from "../../src/helpers/json.js";
import { HumanMessage, MessageCodec, type MessageData } from "../../src/index.js";
import { validateBatch } from "../../src/state/commit.js";
import { initialBatch } from "../../src/testing/storage-conformance.js";

function batch(messages: readonly MessageData[]) {
  const value = initialBatch();
  value.checkpoint.state.messages = messages;
  return value;
}

it("validates proven message snapshots without constructing and cloning Messages", () => {
  const value = batch([MessageCodec.encode(new HumanMessage("history", {
    id: "first", metadata: { tags: ["project"] }, providerState: { signature: "opaque" },
  }))]);
  const clone = vi.spyOn(globalThis, "structuredClone");
  try {
    validateBatch(value);
    expect(clone).not.toHaveBeenCalled();
    expect(value.checkpoint.state.messages[0]!.content).toEqual([{ type: "text", text: "history" }]);
  } finally { clone.mockRestore(); }
});

it("still validates schema, roles and content semantics in proven JSON snapshots", () => {
  const message = MessageCodec.encode(new HumanMessage("valid", { id: "message" }));
  for (const [patch, code] of [
    [{ schemaVersion: 99 }, "SchemaIncompatible"], [{ id: "" }, "InvalidConfiguration"],
    [{ role: "unknown" }, "InvalidMessage"], [{ role: "tool" }, "InvalidConfiguration"],
    [{ content: [{ type: "unknown" }] }, "InvalidMessage"],
    [{ content: [{ type: "text", text: 1 }] }, "InvalidMessage"],
    [{ content: [{ type: "text", text: "x", metadata: [] }] }, "InvalidMessage"],
    [{ content: [{ type: "tool-call", toolCallId: "c", name: "work", arguments: [] }] }, "InvalidMessage"],
    [{ content: [{ type: "data" }] }, "InvalidMessage"],
    [{ content: [{ type: "file", mediaType: "", data: "x" }] }, "InvalidConfiguration"],
  ] as const) {
    const invalid = immutable({ ...message, ...patch });
    expect(() => validateBatch(batch([invalid as never]))).toThrowError(expect.objectContaining({ code }));
  }
});

it("preserves string normalization and unusual array clone errors", () => {
  const message = MessageCodec.encode(new HumanMessage("valid", { id: "message" }));
  for (const string of [{ ...message, content: "text" }, immutable({ ...message, content: "text" })])
    expect(() => validateBatch(batch([string as never]))).not.toThrow();
  const parts = [{ type: "text" as const, text: "x" }];
  Object.assign(parts, { extra: () => { } });
  expect(() => validateBatch(batch([{ ...message, content: parts }]))).toThrowError(expect.objectContaining({ name: "DataCloneError" }));
});

it("keeps cross-message identity and tool-call validation for frozen inputs", () => {
  const message = MessageCodec.encode(new HumanMessage("valid", { id: "same" }));
  expect(() => validateBatch(batch([message, message]))).toThrowError(expect.objectContaining({ code: "InvalidMessage" }));
  const call = immutable({
    schemaVersion: 1, id: "call", role: "assistant", content: [
      { type: "tool-call", toolCallId: "c", name: "work", arguments: {} },
    ]
  });
  const terminal = batch([call as never]);
  terminal.checkpoint.cause = "Terminal";
  expect(() => validateBatch(terminal)).toThrowError(expect.objectContaining({ code: "InvalidMessage" }));
  const unmatched = immutable({ schemaVersion: 1, id: "result", role: "tool", toolCallId: "absent", content: [] });
  expect(() => validateBatch(batch([unmatched as never]))).toThrowError(expect.objectContaining({ code: "InvalidMessage" }));
});
