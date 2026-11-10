import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { expect, it } from "vitest";
import {
  Agent,
  Controller,
  HumanMessage,
  ToolDecision,
  createTool,
  defineInterruption,
  errorInfo,
  normalizeInstruction,
  stream as streamHooks,
  tool as toolHooks,
  type JsonObject,
} from "@tessar/core";
import { z } from "zod";
import { OpenAIChat } from "../src/index.js";

function sse(chunks: unknown[]) {
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}
function chunk(id: string, delta: object, finish_reason: string | null = null) {
  return {
    id,
    object: "chat.completion.chunk",
    model: "fixture",
    created: 1,
    choices: [{ index: 0, delta, finish_reason, logprobs: null }],
  };
}
function completed(text = "ok", id = "chat_1") {
  return sse([
    chunk(id, { role: "assistant", content: text }),
    chunk(id, {}, "stop"),
  ]);
}

it("uses Chat Completions with native options, ordered system content and no injected cache or usage defaults", async () => {
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const model = new OpenAIChat({
    api: "chat-completions",
    apiKey: "test",
    baseURL: "https://compatible.test/v1",
    model: "fixture",
    reasoning_effort: "high",
    max_tokens: 100,
    defaultHeaders: { "X-App": "test" },
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(init!.body as string),
        headers: new Headers(init!.headers),
      });
      return completed();
    },
  });
  const agent = new Agent({
    id: randomUUID(),
    model,
    instructions: {
      sections: [
        { id: "dynamic", order: 1000, content: "last" },
        { id: "base", content: "first" },
      ],
    },
  });
  expect((await agent.generate("hello")).output[0]!.content[0]).toMatchObject({
    text: "ok",
  });
  expect(calls[0]!.url).toBe("https://compatible.test/v1/chat/completions");
  expect(calls[0]!.headers.get("x-app")).toBe("test");
  expect(calls[0]!.body).toEqual({
    model: "fixture",
    reasoning_effort: "high",
    max_tokens: 100,
    stream: true,
    messages: [
      { role: "system", content: "first\n\nlast" },
      { role: "user", content: "hello" },
    ],
  });
  for (const field of [
    "api",
    "instructions",
    "input",
    "temperature",
    "tools",
    "store",
    "stream_options",
    "prompt_cache_options",
    "prompt_cache_key",
  ])
    expect(calls[0]!.body).not.toHaveProperty(field);
});

it("keeps protocol and connection for model-ID overrides and allows an execution-local protocol/model replacement", async () => {
  const calls: { url: string; body: any }[] = [];
  const chat = new OpenAIChat({
    api: "chat-completions",
    apiKey: "test",
    model: "first",
    temperature: 0.5,
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init!.body as string) });
      return completed();
    },
  });
  const agent = new Agent({ id: randomUUID(), model: chat });
  await agent.generate("hello", {
    model: "second",
    modelOptions: { temperature: 0.1, max_tokens: 50 },
  });
  expect(calls[0]!.url).toContain("/chat/completions");
  expect(calls[0]!.body).toMatchObject({
    model: "second",
    temperature: 0.1,
    max_tokens: 50,
  });
  expect(chat.withModel("third").ref.connectionId).toBe(chat.ref.connectionId);
  expect(chat.withModel("third").api).toBe("chat-completions");
  await agent.generate("default");
  expect(calls[1]!.body).toMatchObject({ model: "first", temperature: 0.5 });
  expect(calls[1]!.body).not.toHaveProperty("max_tokens");
  const responses = new OpenAIChat({
    api: "responses",
    apiKey: "other",
    model: "other",
    fetch: async (url) => {
      expect(String(url)).toContain("/responses");
      return new Response(
        'data: {"type":"response.completed","response":{"id":"resp","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"response","annotations":[]}]}]}}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  expect(
    (await agent.generate("override", { model: responses })).output[0]!
      .content[0],
  ).toMatchObject({ text: "response" });
});

it("executes fragmented parallel function calls and replays reasoning/tool identities in native chat history", async () => {
  const bodies: any[] = [];
  const add = createTool({
    name: "add",
    description: "Add one",
    schema: z.object({ value: z.number() }),
    execute: ({ value }) => ({ value: value + 1 }),
  });
  const model = new OpenAIChat({
    api: "chat-completions",
    apiKey: "test",
    model: "fixture",
    stream_options: { include_usage: true },
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return bodies.length === 1
        ? sse([
            chunk("calls", {
              role: "assistant",
              reasoning_content: "reason",
              tool_calls: [
                {
                  index: 1,
                  id: "call-b",
                  type: "function",
                  function: { name: "add", arguments: '{"value":' },
                },
                {
                  index: 0,
                  id: "call-a",
                  type: "function",
                  function: { name: "add", arguments: '{"value":1}' },
                },
              ],
            }),
            chunk("calls", {
              reasoning_content: "ing",
              tool_calls: [{ index: 1, function: { arguments: "2}" } }],
            }),
            chunk("calls", {}, "tool_calls"),
            {
              id: "calls",
              choices: [],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120,
                prompt_tokens_details: {
                  cached_tokens: 40,
                  cache_write_tokens: 30,
                },
                completion_tokens_details: { reasoning_tokens: 10 },
              },
            },
          ])
        : completed("done", "answer");
    },
  });
  const result = await new Agent({
    id: randomUUID(),
    model,
    tools: { add },
  }).generate("add twice");
  expect(result.status).toBe("completed");
  expect(bodies).toHaveLength(2);
  expect(bodies[0].tools).toEqual([
    {
      type: "function",
      function: {
        name: "add",
        description: "Add one",
        parameters: add.jsonSchema,
      },
    },
  ]);
  const assistant = bodies[1].messages.find(
    (message: any) => message.role === "assistant",
  );
  expect(assistant.reasoning_content).toBe("reasoning");
  expect(assistant.tool_calls).toEqual([
    {
      id: "call-a",
      type: "function",
      function: { name: "add", arguments: '{"value":1}' },
    },
    {
      id: "call-b",
      type: "function",
      function: { name: "add", arguments: '{"value":2}' },
    },
  ]);
  expect(
    bodies[1].messages.filter((message: any) => message.role === "tool"),
  ).toEqual([
    { role: "tool", tool_call_id: "call-a", content: '{"value":2}' },
    { role: "tool", tool_call_id: "call-b", content: '{"value":3}' },
  ]);
  expect(result.usage.metrics.cacheReadInputTokens.knownTotal).toBe(40);
  expect(result.usage.metrics.cacheWriteInputTokens.knownTotal).toBe(30);
  expect(result.usage.metrics.reasoningOutputTokens.knownTotal).toBe(10);
});

it("reports missing chat usage as unavailable and preserves supplied native cache options", async () => {
  let body: any;
  const model = new OpenAIChat({
    api: "chat-completions",
    apiKey: "test",
    model: "fixture",
    prompt_cache_key: "app",
    fetch: async (_url, init) => {
      body = JSON.parse(init!.body as string);
      return completed();
    },
  });
  const result = await new Agent({ id: randomUUID(), model }).generate("hello");
  expect(body.prompt_cache_key).toBe("app");
  expect(result.usage.metrics.inputTokens.coverage).toBe("unavailable");
  expect(result.usage.metrics.cacheReadInputTokens.knownTotal).toBeNull();
});

it("retains Chat SDK errors and retries without restarting partially emitted streams", async () => {
  let calls = 0;
  const model = new OpenAIChat({
    api: "chat-completions",
    apiKey: "test",
    model: "fixture",
    maxRetries: 1,
    fetch: async () => {
      if (++calls === 1)
        return new Response(
          '{"error":{"message":"busy","code":"rate_limit_exceeded"}}',
          { status: 429, headers: { "retry-after-ms": "1" } },
        );
      return completed();
    },
  });
  expect(
    (await new Agent({ id: randomUUID(), model }).generate("retry")).status,
  ).toBe("completed");
  expect(calls).toBe(2);
  const exhausted = new OpenAIChat({
    api: "chat-completions",
    apiKey: "test",
    model: "fixture",
    maxRetries: 0,
    fetch: async () =>
      new Response(
        '{"error":{"message":"busy","code":"rate_limit_exceeded"}}',
        { status: 429 },
      ),
  });
  await expect(
    new Agent({ id: randomUUID(), model: exhausted }).generate("fail"),
  ).rejects.toBeInstanceOf(OpenAI.RateLimitError);
  let partialCalls = 0;
  const partial = new OpenAIChat({
    api: "chat-completions",
    apiKey: "test",
    model: "fixture",
    maxRetries: 3,
    fetch: async () => {
      partialCalls++;
      return sse([chunk("partial", { content: "partial" })]);
    },
  });
  await expect(
    new Agent({ id: randomUUID(), model: partial }).generate("fail"),
  ).rejects.toMatchObject({ code: "ProviderIncomplete" });
  expect(partialCalls).toBe(1);
});

it("rejects protocol overrides, invalid protocol names, multiple choices and incompatible opaque history", async () => {
  let calls = 0;
  const model = new OpenAIChat({
    api: "chat-completions",
    apiKey: "test",
    model: "fixture",
    fetch: async () => {
      calls++;
      return completed();
    },
  });
  await expect(
    new Agent({ id: randomUUID(), model }).generate("bad", {
      modelOptions: { api: "responses" } as any,
    }),
  ).rejects.toMatchObject({ code: "UnsupportedOption" });
  expect(calls).toBe(0);
  expect(
    () =>
      new OpenAIChat({
        api: "auto",
        apiKey: "test",
        model: "fixture",
      } as any),
  ).toThrow();
  expect(
    () =>
      new OpenAIChat({
        api: "chat-completions",
        apiKey: "test",
        model: "fixture",
        n: 2,
      } as any),
  ).toThrowError(expect.objectContaining({ code: "UnsupportedOption" }));
  const result = await new Agent({ id: randomUUID(), model }).generate("first");
  const request = {
    model: model.ref,
    instructions: normalizeInstruction(""),
    messages: result.output,
    tools: [],
  };
  const other = new OpenAIChat({
    api: "chat-completions",
    apiKey: "other",
    model: "fixture",
  });
  expect(() => other.validate({ ...request, model: other.ref })).toThrowError(
    expect.objectContaining({ code: "UnsupportedContext" }),
  );
  const responses = new OpenAIChat({ apiKey: "test", model: "fixture" });
  expect(() =>
    responses.validate({ ...request, model: responses.ref }),
  ).toThrowError(expect.objectContaining({ code: "UnsupportedContext" }));
});

it("rejects malformed streamed function arguments as provider response errors", async () => {
  const model = new OpenAIChat({
    api: "chat-completions",
    apiKey: "test",
    model: "fixture",
    fetch: async () =>
      sse([
        chunk("bad", {
          tool_calls: [
            {
              index: 0,
              id: "call",
              type: "function",
              function: { name: "tool", arguments: "{bad" },
            },
          ],
        }),
        chunk("bad", {}, "tool_calls"),
      ]),
  });
  try {
    await new Agent({ id: randomUUID(), model }).generate("bad");
    throw Error("Expected failure");
  } catch (error) {
    expect(errorInfo(error)).toMatchObject({
      code: "ProviderResponse",
      source: "provider",
    });
  }
});

it.each(["missing", "duplicate"])(
  "rejects %s tool identities before executing any tool",
  async (kind) => {
    let executions = 0,
      requests = 0;
    const tool = createTool({
      name: "tool",
      description: "Fixture",
      schema: z.object({}),
      execute: () => {
        executions++;
        return "done";
      },
    });
    const model = new OpenAIChat({
      api: "chat-completions",
      apiKey: "test",
      model: "fixture",
      fetch: async () => {
        if (++requests > 1) return completed();
        const tool_calls =
          kind === "missing"
            ? []
            : [0, 1].map((index) => ({
                index,
                id: "same-id",
                type: "function",
                function: { name: "tool", arguments: "{}" },
              }));
        return sse([
          chunk("bad", { tool_calls }),
          chunk("bad", {}, "tool_calls"),
        ]);
      },
    });
    await expect(
      new Agent({ id: randomUUID(), model, tools: { tool } })
        .generate("bad")
        .then(() => undefined),
    ).rejects.toMatchObject({ code: "ProviderResponse" });
    expect(executions).toBe(0);
  },
);

it.each(["responses", "chat-completions"] as const)(
  "blocks connection options from untyped %s request overrides",
  async (api) => {
    let requests = 0;
    const model = new OpenAIChat({
      api,
      apiKey: "test",
      model: "fixture",
      fetch: async () => {
        requests++;
        return completed();
      },
    });
    for (const options of [
      { organization: "other" },
      { defaultQuery: { secret: "value" } },
    ] as JsonObject[]) {
      expect(() =>
        model.validate({
          model: model.ref,
          instructions: normalizeInstruction(""),
          messages: [],
          tools: [],
          options,
        }),
      ).toThrowError(expect.objectContaining({ code: "UnsupportedOption" }));
      expect(
        await new Agent({ id: randomUUID(), model }).generate("bad", {
          modelOptions: options as any,
        }),
      ).toMatchObject({
        status: "failed",
        error: { code: "UnsupportedOption" },
      });
    }
    expect(requests).toBe(0);
  },
);

it("encodes user media without sending application metadata or adding image defaults", async () => {
  let body: any;
  const model = new OpenAIChat({
    api: "chat-completions",
    apiKey: "test",
    model: "fixture",
    fetch: async (_url, init) => {
      body = JSON.parse(init!.body as string);
      return completed();
    },
  });
  const message = new HumanMessage(
    [
      { type: "text", text: "Read these", metadata: { hidden: true } },
      {
        type: "image",
        mediaType: "image/png",
        data: "aGVsbG8=",
        metadata: { source: "upload" },
      },
      {
        type: "file",
        mediaType: "application/pdf",
        data: "data:application/pdf;base64,cGRm",
        metadata: { page: 1 },
      },
    ],
    { metadata: { private: true } },
  );
  await new Agent({ id: randomUUID(), model }).generate(message);
  expect(body.messages).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "Read these" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,aGVsbG8=" },
        },
        {
          type: "file",
          file: { file_data: "data:application/pdf;base64,cGRm" },
        },
      ],
    },
  ]);
  expect(() =>
    model.validate({
      model: model.ref,
      instructions: normalizeInstruction(""),
      tools: [],
      messages: [
        new HumanMessage([
          { type: "audio", mediaType: "audio/wav", data: "aGVsbG8=" },
        ]),
      ],
    }),
  ).toThrowError(expect.objectContaining({ code: "UnsupportedContext" }));
});

it("preserves native Chat reasoning and tool history through Session suspension, resume and queued follow-up", async () => {
  const bodies: any[] = [];
  let executions = 0;
  const model = new OpenAIChat({
    api: "chat-completions",
    apiKey: "test",
    model: "fixture",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return bodies.length === 1
        ? sse([
            chunk("call", {
              reasoning_content: "Check permission",
              tool_calls: [
                {
                  index: 0,
                  id: "call-id",
                  type: "function",
                  function: { name: "write", arguments: "{}" },
                },
              ],
            }),
            chunk("call", {}, "tool_calls"),
          ])
        : completed("done", "answer-" + bodies.length);
    },
  });
  const approval = defineInterruption({
    id: "approval",
    version: 1,
    response: { jsonSchema: {}, parse: () => ({}) },
    resolve: () => ToolDecision.allow(),
  });
  const write = createTool({
    name: "write",
    description: "Write",
    schema: z.object({}),
    execute: () => {
      executions++;
      return "written";
    },
  });
  const agent = new Agent({ id: randomUUID(), model, tools: { write } });
  const controller = new Controller({
    id: "host",
    agent,
    plugins: [
      {
        id: "approval",
        setup(tessar) {
          tessar.interruptions.register(approval);
          tessar.hook(toolHooks.before, (_event, context) =>
            context.suspend(approval, {}),
          );
        },
      },
    ],
  });
  await controller.initialize();
  try {
    const session = await controller.createSession();
    await session.thread.create();
    const pending = new Promise<any>((resolve) =>
      session.subscribe(streamHooks.suspended, resolve),
    );
    await session.followUp(new HumanMessage("write"));
    await session.followUp(new HumanMessage("next"));
    const event = await pending;
    expect(executions).toBe(0);
    expect(bodies).toHaveLength(1);
    const done = new Promise<void>((resolve, reject) => {
      let ends = 0;
      session.subscribe(streamHooks.error, (event) =>
        reject(Error(event.payload.error.code)),
      );
      session.subscribe(streamHooks.end, () => {
        if (++ends === 2) resolve();
      });
    });
    await session.resume({
      interruptId: event.payload.interrupt.id,
      value: {},
    });
    await done;
    expect(executions).toBe(1);
    expect(bodies).toHaveLength(3);
    expect(
      bodies[1].messages.find((message: any) => message.role === "assistant"),
    ).toMatchObject({
      reasoning_content: "Check permission",
      tool_calls: [{ id: "call-id" }],
    });
    expect(bodies[2].messages.slice(-2)).toEqual([
      { role: "assistant", content: "done" },
      { role: "user", content: "next" },
    ]);
    expect(
      bodies[2].messages.filter((message: any) => message.role === "tool"),
    ).toEqual([{ role: "tool", tool_call_id: "call-id", content: "written" }]);
  } finally {
    await controller.dispose();
  }
});
