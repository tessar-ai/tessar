import { expect, it } from "vitest";
import OpenAI from "openai";
import { Agent, errorInfo, normalizeInstruction } from "@tessar/core";
import { OpenAIProvider } from "../src/index.js";
import { OpenAIAdapter } from "../src/adapter.js";
import { OpenAIChatAdapter } from "../src/chat-adapter.js";

for (const api of ["responses", "chat-completions"] as const) {
  it(`${api} rejects duplicate tool-call identities as a provider failure`, async () => {
    const data =
      api === "responses"
        ? `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "response", output: [0, 1].map((index) => ({ id: "item" + index, type: "function_call", call_id: "same", name: "test", arguments: "{}" })) } })}\n\n`
        : `data: ${JSON.stringify({ id: "chat", choices: [{ index: 0, delta: { tool_calls: [0, 1].map((index) => ({ index, id: "same", type: "function", function: { name: "test", arguments: "{}" } })) }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
    const model = new OpenAIProvider({
      api,
      apiKey: "fixture",
      model: "fixture",
      maxRetries: 0,
      fetch: async () =>
        new Response(data, {
          headers: { "Content-Type": "text/event-stream" },
        }),
    });
    const agent = new Agent({ id: crypto.randomUUID(), model });
    try {
      const failure = await agent.generate("task").then(
        () => null,
        (error) => error,
      );
      expect(failure).not.toBeNull();
      expect(errorInfo(failure)).toMatchObject({
        code: "ProviderResponse",
        source: "provider",
      });
    } finally {
      await agent.shutdown();
    }
  });
  it.each(["id", "name"])(
    `${api} rejects missing tool %s as a provider failure`,
    async (missing) => {
      const id = missing === "id" ? "" : "call",
        name = missing === "name" ? "" : "test";
      const data =
        api === "responses"
          ? `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "response", output: [{ id: "item", type: "function_call", call_id: id, name, arguments: "{}" }] } })}\n\n`
          : `data: ${JSON.stringify({ id: "chat", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
      const model = new OpenAIProvider({
        api,
        apiKey: "fixture",
        model: "fixture",
        maxRetries: 0,
        fetch: async () =>
          new Response(data, {
            headers: { "Content-Type": "text/event-stream" },
          }),
      });
      const agent = new Agent({ id: crypto.randomUUID(), model });
      try {
        const failure = await agent.generate("task").then(
          () => null,
          (error) => error,
        );
        expect(failure).not.toBeNull();
        expect(errorInfo(failure)).toMatchObject({
          code: "ProviderResponse",
          source: "provider",
        });
      } finally {
        await agent.shutdown();
      }
    },
  );
  it.each(["{", "[]"])(
    `${api} throws malformed provider tool arguments as provider errors: %s`,
    async (args) => {
      const data =
        api === "responses"
          ? `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1, response: { id: "r", status: "completed", output: [{ type: "function_call", call_id: "call", name: "test", arguments: args }] } })}\n\n`
          : `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "test", arguments: args } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
      const model = new OpenAIProvider({
        api,
        apiKey: "fixture",
        model: "fixture",
        maxRetries: 0,
        fetch: async () =>
          new Response(data, {
            headers: { "Content-Type": "text/event-stream" },
          }),
      });
      const agent = new Agent({ id: crypto.randomUUID(), model });
      try {
        const error = await agent.generate("task").then(
          () => null,
          (error) => error,
        );
        expect(error).not.toBeNull();
        expect(errorInfo(error)).toMatchObject({
          code: "ProviderResponse",
          source: "provider",
          providerId: "openai",
        });
      } finally {
        await agent.shutdown();
      }
    },
  );
}

it.each([OpenAIAdapter, OpenAIChatAdapter])(
  "keeps adapter implementation exceptions distinct from provider failures: %j",
  async (Adapter) => {
    const failure = new TypeError("adapter implementation bug");
    const create = async () => {
      throw failure;
    };
    const client = {
      responses: { create },
      chat: { completions: { create } },
    } as unknown as OpenAI;
    const model = new Adapter(
      { apiKey: "fixture" },
      { providerId: "openai", modelId: "fixture" },
      client,
    );
    await expect(async () => {
      for await (const _chunk of model.stream(
        {
          model: model.ref,
          instructions: normalizeInstruction(""),
          messages: [],
          tools: [],
        },
        { signal: new AbortController().signal },
      )) {
      }
    }).rejects.toBe(failure);
    expect(errorInfo(failure)).toMatchObject({
      source: "tessar",
      name: "TypeError",
    });
  },
);
