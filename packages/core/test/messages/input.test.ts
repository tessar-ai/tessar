import { expect, it, vi } from "vitest";
import { HumanMessage, ToolMessage } from "../../src/messages/message.js";
import { inputMessages, MessageCodec } from "../../src/messages/codec.js";

it("normalizes input without cloning the completed wire projection again", () => {
  const message = new HumanMessage("question", {
    id: "input", metadata: { tags: ["project"] }, providerState: { signature: "opaque" },
  });
  const clone = vi.spyOn(globalThis, "structuredClone");
  try {
    const [wire] = inputMessages(message);
    expect(wire).toEqual({
      schemaVersion: 1, id: "input", role: "user", content: [{ type: "text", text: "question" }],
      metadata: { tags: ["project"] }, providerState: { signature: "opaque" },
    });
    expect(Object.getPrototypeOf(wire)).toBe(Object.prototype);
    expect(Object.isFrozen(wire)).toBe(true);
    expect(Object.isFrozen(wire!.metadata!.tags)).toBe(true);
    expect(clone.mock.calls.length).toBeLessThanOrEqual(4);
  } finally { clone.mockRestore(); }
});

it("detaches mutable input and retains validation and tool correlation", () => {
  const content = [{ type: "text" as const, text: "original" }];
  const metadata = { tags: ["original"] };
  const providerState = { signature: "original" };
  const input = {
    schemaVersion: 1 as const, id: "input", role: "user" as const, content, metadata, providerState,
    ignored: new Date()
  };
  const [wire] = inputMessages(input);
  content[0]!.text = "changed";
  metadata.tags.push("changed");
  providerState.signature = "changed";
  expect(wire!.content).toEqual([{ type: "text", text: "original" }]);
  expect(wire!.metadata).toEqual({ tags: ["original"] });
  expect(wire!.providerState).toEqual({ signature: "original" });
  expect(wire).not.toHaveProperty("ignored");
  expect(Object.isFrozen(input.content)).toBe(false);
  const tool = new ToolMessage("answer", { id: "result", toolCallId: "call" });
  expect(inputMessages([tool])[0]).toEqual(MessageCodec.encode(tool));
  for (const bad of [
    { ...input, schemaVersion: 99 }, { ...input, id: "" }, { ...input, role: "unknown" },
    { ...input, content: [{ type: "unknown" }] }, { ...input, metadata: { invalid: NaN } },
    new ToolMessage("unbound"),
  ]) expect(() => inputMessages(bad as never)).toThrow();
});
