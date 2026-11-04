import { expect, it } from "vitest";
import { normalizeInstruction, MessageCodec } from "@tessar/core";
import { OpenAIChat } from "../src/provider.js";
import { decodeOutput } from "../src/codec.js";
import { decodeChatMessage } from "../src/chat-codec.js";

for (const api of ["responses", "chat-completions"] as const) {
  it(`${api} restores a stable binding but rejects a changed endpoint`, () => {
    const options = {
      apiKey: "secret",
      model: "test",
      api,
      connectionId: "primary",
      baseURL: "https://one.test/v1",
    };
    const a = new OpenAIChat(options),
      b = new OpenAIChat(options);
    const message =
      api === "responses"
        ? decodeOutput(
            [
              {
                type: "message",
                role: "assistant",
                content: [
                  { type: "output_text", text: "hello", annotations: [] },
                ],
              },
            ],
            a.ref,
            "answer",
            a.connection,
          )
        : decodeChatMessage(
            { role: "assistant", content: "hello" },
            a.ref,
            "answer",
            a.connection,
          );
    const request = {
      model: b.ref,
      instructions: normalizeInstruction(""),
      tools: [],
      messages: [JSON.parse(JSON.stringify(MessageCodec.encode(message)))],
    };
    expect(() => b.validate(request)).not.toThrow();
    const changed = new OpenAIChat({
      ...options,
      baseURL: "https://two.test/v1",
    });
    expect(() =>
      changed.validate({ ...request, model: changed.ref }),
    ).toThrowError(expect.objectContaining({ code: "UnsupportedContext" }));
    expect(a.withModel("other").connection).toEqual(a.connection);
    expect(a.options).not.toHaveProperty("connectionId");
    expect(() =>
      b.validate({ ...request, options: { connectionId: "other" } }),
    ).toThrow();
  });
}

for (const api of ["responses", "chat-completions"] as const)
  it(`${api} requires explicit legacy identity and rejects protocol changes`, () => {
    const original = new OpenAIChat({
      apiKey: "fixture",
      model: "fixture",
      api,
    });
    const message =
      api === "responses"
        ? decodeOutput(
            [
              {
                type: "message",
                role: "assistant",
                content: [
                  { type: "output_text", text: "old", annotations: [] },
                ],
              },
            ],
            original.ref,
            "old",
          )
        : decodeChatMessage(
            { role: "assistant", content: "old" },
            original.ref,
            "old",
          );
    const request = (
      provider: OpenAIChat<"responses" | "chat-completions">,
    ) => ({
      model: provider.ref,
      instructions: normalizeInstruction(""),
      messages: [MessageCodec.encode(message)],
      tools: [],
    });
    const implicit = new OpenAIChat({
      apiKey: "fixture",
      model: "fixture",
      api,
    });
    expect(() => implicit.validate(request(implicit))).toThrow();
    const rebound = new OpenAIChat({
      apiKey: "fixture",
      model: "fixture",
      api,
      connectionId: original.ref.connectionId!,
    });
    expect(() => rebound.validate(request(rebound))).not.toThrow();
    const different = new OpenAIChat({
      apiKey: "fixture",
      model: "fixture",
      api: api === "responses" ? "chat-completions" : "responses",
      connectionId: original.ref.connectionId!,
    });
    expect(() => different.validate(request(different))).toThrow();
  });
