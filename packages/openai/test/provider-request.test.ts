import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  Agent,
  Controller,
  errorInfo,
  type JsonObject,
  type ModelCallContext,
  type ModelAdapter,
  type ModelRequest,
  normalizeInstruction,
} from "@tessar/core";
import { OpenAIProvider } from "../src/index.js";

type Protocol = "responses" | "chat-completions";
function completion(api: Protocol) {
  return api === "responses"
    ? new Response(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          sequence_number: 1,
          response: {
            id: "r1",
            status: "completed",
            output: [
              {
                type: "message",
                id: "m1",
                role: "assistant",
                content: [
                  { type: "output_text", text: "answer", annotations: [] },
                ],
              },
            ],
          },
        })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      )
    : new Response(
        `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "answer" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
}

function fixture(api: Protocol, fetcher?: (body: any) => Response) {
  const sent: any[] = [];
  const model = new OpenAIProvider({
    api,
    apiKey: "test",
    model: "fixture",
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      sent.push(body);
      return fetcher?.(body) ?? completion(api);
    },
  });
  const request: ModelRequest = {
    model: model.ref,
    instructions: normalizeInstruction("system"),
    messages: [],
    tools: [],
  };
  return { model, request, sent };
}

async function consume(
  model: ModelAdapter,
  request: ModelRequest,
  context: ModelCallContext,
) {
  for await (const _chunk of model.stream(request, context)) {
    /* Consume SDK output. */
  }
}

for (const api of ["responses", "chat-completions"] as const) {
  it(`${api} prepares encoded body through Controller plugins before HTTP send`, async () => {
    const f = fixture(api);
    const agent = new Agent({
      id: randomUUID(),
      model: f.model,
      instructions: "system",
    });
    const controller = new Controller({
      id: randomUUID(),
      agent,
      plugins: [
        {
          id: "native",
          setup(tessar) {
            tessar.hook("provider.request", (event) => {
              expect(event.payload).toMatchObject({
                protocol: api,
                model: f.model.ref,
                purpose: "primary",
              });
              const body = event.payload.body;
              expect(body).toMatchObject({ model: "fixture", stream: true });
              if (api === "responses") expect(body.instructions).toBe("system");
              else
                expect(body.messages).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({ role: "system" }),
                  ]),
                );
              return {
                ...event.payload,
                body: { ...body, service_tier: "auto", temperature: 0 },
              };
            });
          },
        },
      ],
    });
    try {
      await controller.initialize();
      const result = await agent.generate("hello");
      expect(result.status).toBe("completed");
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0]).toMatchObject({ service_tier: "auto", temperature: 0 });
      expect(f.sent[0].attemptId).toBeUndefined();
    } finally {
      await controller.dispose();
    }
  });

  it(`${api} preserves body defaults without request hooks`, async () => {
    const f = fixture(api);
    await consume(f.model, f.request, { signal: new AbortController().signal });
    expect(f.sent[0]).not.toHaveProperty("temperature");
    expect(f.sent[0]).not.toHaveProperty("service_tier");
    expect(f.sent[0]).not.toHaveProperty("stream_options");
  });

  it(`${api} preserves callback error identity and prevents HTTP dispatch`, async () => {
    const f = fixture(api);
    const failure = new Error("plugin failed");
    errorInfo(failure, { source: "plugin", pluginId: "policy" });
    await expect(
      consume(f.model, f.request, {
        signal: new AbortController().signal,
        prepareRequest: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(errorInfo(failure).source).toBe("plugin");
    expect(f.sent).toEqual([]);
  });

  it(`${api} checks cancellation after asynchronous preparation`, async () => {
    const f = fixture(api);
    const abort = new AbortController();
    await expect(
      consume(f.model, f.request, {
        signal: abort.signal,
        prepareRequest: async (_protocol, body) => {
          abort.abort(new Error("cancelled"));
          return body;
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(f.sent).toEqual([]);
  });

  const changes: [string, JsonObject][] = [
    ["different model", { model: "different" }],
    ["stream disabled", { stream: false }],
    ["connection fields", { baseURL: "https://other.test" }],
    ...(api === "responses"
      ? ([
          ["background", { background: true }],
          ["conversation", { conversation: "other" }],
          ["previous response", { previous_response_id: "r0" }],
          ["managed compaction", { context_management: [] }],
        ] as [string, JsonObject][])
      : ([
          ["multiple choices", { n: 2 }],
          ["legacy function call", { function_call: "auto" }],
        ] as [string, JsonObject][])),
  ];
  it.each(changes)(
    `${api} rejects %s introduced after normalized validation`,
    async (_name, patch) => {
      const f = fixture(api);
      await expect(
        consume(f.model, f.request, {
          signal: new AbortController().signal,
          prepareRequest: async (_protocol, body) => ({ ...body, ...patch }),
        }),
      ).rejects.toMatchObject({ name: "TessarError" });
      expect(f.sent).toEqual([]);
    },
  );

  it(`${api} prepares once per adapter call and reuses the body for SDK retries`, async () => {
    let preparations = 0;
    const sent: any[] = [];
    const model = new OpenAIProvider({
      api,
      apiKey: "test",
      model: "fixture",
      maxRetries: 1,
      fetch: async (_url, init) => {
        sent.push(JSON.parse(init!.body as string));
        return sent.length === 1
          ? new Response('{"error":{"message":"busy"}}', {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "retry-after-ms": "1",
              },
            })
          : completion(api);
      },
    });
    const request = {
      model: model.ref,
      instructions: normalizeInstruction(""),
      messages: [],
      tools: [],
    };
    const context: ModelCallContext = {
      signal: new AbortController().signal,
      prepareRequest: async (_protocol, body) => ({
        ...body,
        seed: ++preparations,
      }),
    };
    await consume(model, request, context);
    expect(preparations).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    await consume(model, request, context);
    expect(preparations).toBe(2);
    expect(sent[2].seed).toBe(2);
  });
}
