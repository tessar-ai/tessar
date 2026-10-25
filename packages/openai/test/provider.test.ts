import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { Agent, Controller, HumanMessage, normalizeInstruction } from "@tessar/core";
import OpenAI from "openai";
import { OpenAIProvider, OpenAIPlugin } from "../src/index.js";

it.each(["responses", "chat-completions"] as const)("builds the same native %s connection through OpenAIPlugin", async (api) => {
  const calls: { url: string; body: any }[] = [];
  let registration!: import("@tessar/core").ModelProviderRegistration;
  const plugin = new OpenAIPlugin({ api, apiKey: "test", baseURL: "https://plugin.test/v1", connectionId: "plugin", temperature: 0.3,
    fetch: async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      if (api === "responses") return completed();
      return new Response('data: {"id":"chat","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  await plugin.setup({ models: { register(value) { registration = value; } } } as import("@tessar/core").PluginContext);
  const provider = registration.create("fixture");
  const agent = new Agent({ id: randomUUID(), model: provider });
  try {
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.ref.connectionId).toBe("plugin");
    expect(registration.create("another").connection).toEqual(provider.connection);
    expect((await agent.generate("hello")).status).toBe("completed");
    expect(calls[0]!.url).toBe("https://plugin.test/v1/" + (api === "responses" ? "responses" : "chat/completions"));
    expect(calls[0]!.body.temperature).toBe(0.3);
    for (const key of ["api", "connectionId", "apiKey", "baseURL"])
      expect(calls[0]!.body).not.toHaveProperty(key);
  } finally { await agent.shutdown(); }
});

function completed(text = "ok") {
  return new Response(
    [
      "event: response.output_text.delta\ndata: " +
        JSON.stringify({
          type: "response.output_text.delta",
          item_id: "msg",
          content_index: 0,
          delta: text,
        }),
      "event: response.completed\ndata: " +
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp",
            output: [
              {
                id: "msg",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text, annotations: [] }],
              },
            ],
            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
          },
        }),
    ].join("\n\n") + "\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

it("retains a Session's executable connection across follow-ups, handle restoration and model-ID switches", async () => {
  const calls: { url: string; body: any }[] = [];
  const defaultModel = new OpenAIProvider({ apiKey: "first", model: "fixture", connectionId: "first" });
  const other = new OpenAIProvider({
    apiKey: "other", baseURL: "https://other.test/v1", model: "fixture", connectionId: "other", temperature: 0.25,
    fetch: async (url: any, init: any) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return completed(); },
  });
  const agent = new Agent({ id: randomUUID(), model: defaultModel });
  const controller = new Controller({ id: randomUUID(), agent });
  const ask = async (session: import("@tessar/core").Session) => {
    const done = new Promise<void>((resolve, reject) => {
      const stop = session.subscribe((event) => {
        if (event.type === "stream.end") {
          stop();
          if (event.payload.status === "completed") resolve();
          else reject(Error(event.payload.error?.message ?? event.payload.status));
        }
        if (event.type === "stream.error") { stop(); reject(Error(event.payload.error.message)); }
      });
    });
    await session.followUp("hello");
    await done;
  };
  try {
    await controller.initialize();
    await agent.generate("direct", { model: other });
    const session = await controller.createSession({ model: other, threadId: randomUUID() });
    await ask(session);
    const restored = (await controller.getSession(session.id))!;
    await restored.model.switch("another");
    await restored.thread.create({ id: randomUUID() });
    await ask(restored);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.url === "https://other.test/v1/responses" && call.body.temperature === 0.25)).toBe(true);
    expect(calls.at(-1)!.body.model).toBe("another");
  } finally { await controller.dispose(); }
});

it("forwards native options and headers without adding undeclared provider defaults", async () => {
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const model = new OpenAIProvider({
    apiKey: "test",
    baseURL: "https://gateway.test/v1",
    model: "fixture",
    defaultHeaders: { "X-App": "test" },
    fetch: async (url: any, init: any) => {
      calls.push({
        url: String(url),
        body: JSON.parse(init.body),
        headers: new Headers(init.headers),
      });
      return completed();
    },
  });
  expect(calls).toHaveLength(0);
  expect(model.profile().modelId).toBe("fixture");
  expect(calls).toHaveLength(0);
  const result = await new Agent({ id: randomUUID(), model }).generate("hello");
  expect(result.output[0]!.content[0]).toMatchObject({ text: "ok" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://gateway.test/v1/responses");
  expect(calls[0]!.headers.get("x-app")).toBe("test");
  expect(calls[0]!.body).toMatchObject({ model: "fixture", stream: true });
  for (const key of [
    "temperature",
    "reasoning",
    "max_output_tokens",
    "store",
    "include",
    "instructions",
    "tools",
    "maxRetries",
    "timeout",
  ])
    expect(calls[0]!.body).not.toHaveProperty(key);
});

it("reuses a connection for model IDs and replaces nested options without mutating defaults", async () => {
  const bodies: any[] = [];
  const model = new OpenAIProvider({
    apiKey: "test",
    model: "first",
    reasoning: { effort: "high", summary: "auto" },
    max_output_tokens: 8192,
    fetch: async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return completed();
    },
  });
  const agent = new Agent({ id: randomUUID(), model });
  await agent.generate("one", {
    model: "second",
    modelOptions: { reasoning: { effort: "low" } },
  });
  await agent.generate("two");
  expect(bodies[0]!).toMatchObject({
    model: "second",
    reasoning: { effort: "low" },
    max_output_tokens: 8192,
  });
  expect(bodies[0]!.reasoning).not.toHaveProperty("summary");
  expect(bodies[1]!).toMatchObject({
    model: "first",
    reasoning: { effort: "high", summary: "auto" },
  });
  expect(model.ref.modelId).toBe("first");
});

it("uses SDK retries for eligible provider failures and does not replay the Agent loop", async () => {
  let calls = 0;
  const model = new OpenAIProvider({
    apiKey: "test",
    model: "fixture",
    maxRetries: 1,
    timeout: 1000,
    fetch: async () => {
      calls++;
      return calls === 1
        ? new Response(
            JSON.stringify({
              error: {
                message: "busy",
                type: "rate_limit_error",
                code: "rate_limit_exceeded",
              },
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "retry-after-ms": "1",
              },
            },
          )
        : completed();
    },
  });
  const result = await new Agent({ id: randomUUID(), model }).generate("hello");
  expect(calls).toBe(2);
  expect(result.status).toBe("completed");
});

it("rejects runtime overrides and unsupported execution modes before making requests", async () => {
  let calls = 0;
  const model = new OpenAIProvider({
    apiKey: "test",
    model: "fixture",
    fetch: async () => {
      calls++;
      return completed();
    },
  });
  for (const options of [
    { input: "bypass" },
    { stream: false },
    { model: "bypass" },
  ]) {
    await expect(
      new Agent({ id: randomUUID(), model }).generate("hello", {
        modelOptions: options as any,
      }),
    ).rejects.toMatchObject({ code: "UnsupportedOption" });
  }
  for (const options of [{ background: true }, { previous_response_id: "resp" }]) {
    const result = await new Agent({ id: randomUUID(), model }).generate("hello", { modelOptions: options as any });
    expect(result).toMatchObject({ status: "failed", error: { code: "UnsupportedOption" } });
  }
  const invalid = await new Agent({ id: randomUUID(), model }).generate(
    "hello",
    { modelOptions: { context_management: [{ type: "compaction" }] } as any },
  );
  expect(invalid).toMatchObject({
    status: "failed",
    error: { code: "UnsupportedOption" },
  });
  expect(calls).toBe(0);
  expect(
    () =>
      new OpenAIProvider({
        apiKey: "test",
        model: "fixture",
        context_management: [{ type: "compaction" }],
      } as any),
  ).toThrowError(expect.objectContaining({ code: "UnsupportedOption" }));
});

it("forwards transport configuration to SDK validation instead of the request body", () => {
  expect(
    () =>
      new OpenAIProvider({
        apiKey: "test",
        model: "fixture",
        x509Transport: {} as any,
      }),
  ).toThrowError(
    new OpenAI.OpenAIError(
      "An X.509 transport requires an X.509 workload identity.",
    ),
  );
});

it("keeps opaque continuity bound to the actual connection", async () => {
  const one = new OpenAIProvider({
    apiKey: "one",
    model: "fixture",
    fetch: async () => completed(),
  });
  const two = new OpenAIProvider({
    apiKey: "two",
    model: "fixture",
    fetch: async () => completed(),
  });
  const result = await new Agent({ id: randomUUID(), model: one }).generate(
    "hello",
  );
  const request = {
    model: two.ref,
    instructions: normalizeInstruction(""),
    messages: [new HumanMessage("hello"), ...result.output],
    tools: [],
  };
  expect(() => two.validate(request)).toThrowError(
    expect.objectContaining({ code: "UnsupportedContext" }),
  );
});

it("isolates a different endpoint, credentials and options even with the same model ID", async () => {
  const requests: { url: string; body: any; headers: Headers }[] = [];
  const fetch: any = async (url: any, init: any) => {
    requests.push({
      url: String(url),
      body: JSON.parse(init.body),
      headers: new Headers(init.headers),
    });
    return completed();
  };
  const first = new OpenAIProvider({
    apiKey: "first",
    baseURL: "https://first.test/v1",
    model: "same",
    reasoning: { effort: "high" },
    defaultHeaders: { "X-First": "private" },
    fetch,
  });
  const second = new OpenAIProvider({
    apiKey: "second",
    baseURL: "https://second.test/v1",
    model: "same",
    fetch,
  });
  const agent = new Agent({ id: randomUUID(), model: first });
  await agent.generate("other", {
    model: second,
    modelOptions: { temperature: 0.3 },
  });
  await agent.generate("default");
  expect(requests[0]!.url).toBe("https://second.test/v1/responses");
  expect(requests[0]!.headers.get("authorization")).toBe("Bearer second");
  expect(requests[0]!.headers.has("x-first")).toBe(false);
  expect(requests[0]!.body).toMatchObject({ model: "same", temperature: 0.3 });
  expect(requests[0]!.body).not.toHaveProperty("reasoning");
  expect(requests[1]!.headers.get("authorization")).toBe("Bearer first");
  expect(first.ref.connectionId).not.toBe(second.ref.connectionId);
});

it("leaves retry defaults to the SDK and preserves exhausted SDK errors", async () => {
  let calls = 0;
  const model = new OpenAIProvider({
    apiKey: "test",
    model: "fixture",
    fetch: async () => {
      calls++;
      return new Response(
        JSON.stringify({
          error: {
            message: "busy",
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
          },
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "retry-after-ms": "1",
          },
        },
      );
    },
  });
  await expect(
    new Agent({ id: randomUUID(), model }).generate("hello"),
  ).rejects.toBeInstanceOf(OpenAI.RateLimitError);
  expect(calls).toBe(3); // SDK default: first request plus two retries.
});

it("passes timeout to the SDK and leaves the model reusable after timeout", async () => {
  let calls = 0;
  const model = new OpenAIProvider({
    apiKey: "test",
    model: "fixture",
    maxRetries: 0,
    timeout: 20,
    fetch: async (_url: any, init: any) => {
      if (++calls > 1) return completed();
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new Error("timeout")),
          { once: true },
        );
      });
    },
  });
  const agent = new Agent({ id: randomUUID(), model });
  await expect(agent.generate("one")).rejects.toBeInstanceOf(
    OpenAI.APIConnectionTimeoutError,
  );
  expect((await agent.generate("two")).status).toBe("completed");
  expect(calls).toBe(2);
});

it("does not silently restart a stream after a delta has been emitted", async () => {
  let calls = 0;
  const model = new OpenAIProvider({
    apiKey: "test",
    model: "fixture",
    maxRetries: 3,
    fetch: async () => {
      calls++;
      return new Response(
        [
          "data: " +
            JSON.stringify({
              type: "response.output_text.delta",
              item_id: "msg",
              content_index: 0,
              delta: "partial",
            }),
          "data: " +
            JSON.stringify({
              type: "error",
              code: "server_error",
              message: "stream failed",
            }),
        ].join("\n\n") + "\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  await expect(
    new Agent({ id: randomUUID(), model }).generate("hello"),
  ).rejects.toMatchObject({ code: "server_error" });
  expect(calls).toBe(1);
});
