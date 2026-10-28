import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  Agent,
  AssistantMessage,
  Controller,
  MessageCodec,
  buildInstruction,
  errorInfo,
  type JsonObject,
  type ModelAdapter,
  type ModelCallContext,
  type ModelChunk,
  type ModelRequest,
  type Plugin,
} from "../../src/index.js";

class NativeFixture implements ModelAdapter {
  readonly ref = { providerId: "native", modelId: "fixture" };
  readonly bodies: JsonObject[] = [];
  readonly requests: ModelRequest[] = [];
  validate() {}
  async *stream(
    request: ModelRequest,
    context: ModelCallContext,
  ): AsyncIterable<ModelChunk> {
    this.requests.push(request);
    const encoded = {
      model: this.ref.modelId,
      stream: true,
      input: request.messages,
      encoded: true,
    } as unknown as JsonObject;
    const body = context.prepareRequest
      ? await context.prepareRequest("fixture", encoded)
      : encoded;
    context.signal.throwIfAborted();
    this.bodies.push(body);
    yield {
      type: "response",
      response: {
        message: MessageCodec.encode(new AssistantMessage("answer")),
      },
    };
  }
}

async function host(plugins: Plugin[]) {
  const model = new NativeFixture();
  const agent = new Agent({ id: randomUUID(), model });
  const controller = new Controller({ id: randomUUID(), agent, plugins });
  await controller.initialize();
  return { agent, controller, model };
}

it("chains native body transformations after context preparation without rewriting history", async () => {
  const seen: string[] = [];
  const h = await host([
    {
      id: "first",
      setup(tessar) {
        tessar.hook("context.prepare", (event) => {
          seen.push("context");
          return { ...event.payload, options: { temperature: 0 } };
        });
        tessar.hook("provider.request", (event) => {
          seen.push("first");
          expect(event.payload).toMatchObject({
            protocol: "fixture",
            purpose: "primary",
            body: { encoded: true },
          });
          expect(Object.isFrozen(event.payload.body)).toBe(true);
          return {
            ...event.payload,
            body: { ...event.payload.body, tag: "one", input: [] },
          };
        });
      },
    },
    {
      id: "second",
      setup(tessar) {
        tessar.hook("provider.request", (event) => {
          seen.push("second");
          expect(event.payload.body.tag).toBe("one");
          expect(Object.isFrozen(event.payload.body)).toBe(true);
          return {
            ...event.payload,
            body: { ...event.payload.body, tag: "two" },
          };
        });
      },
    },
    {
      id: "observe",
      setup(tessar) {
        tessar.hook("provider.request", (event) => {
          expect(event.payload.body.tag).toBe("two");
        });
      },
    },
  ]);
  try {
    const result = await h.agent.generate("keep history");
    expect(seen).toEqual(["context", "first", "second"]);
    expect(h.model.bodies[0]).toMatchObject({ tag: "two", input: [] });
    expect(h.model.requests[0]!.messages[0]!.content).toEqual([
      { type: "text", text: "keep history" },
    ]);
    const history = await h.controller.queries.getHistory(result.threadId);
    expect(JSON.stringify(history)).toContain("keep history");
    expect(JSON.stringify(history)).not.toContain('"encoded"');
  } finally {
    await h.controller.dispose();
  }
});

it.each([
  ["missing body", () => ({})],
  ["array body", (p: any) => ({ ...p, body: [] })],
  ["invalid JSON", (p: any) => ({ ...p, body: { bad: undefined } })],
  [
    "model identity",
    (p: any) => ({ ...p, model: { ...p.model, modelId: "other" } }),
  ],
  ["protocol", (p: any) => ({ ...p, protocol: "other" })],
  ["purpose", (p: any) => ({ ...p, purpose: "auxiliary" })],
  ["attempt", (p: any) => ({ ...p, attemptId: "other" })],
])(
  "rejects %s before later handlers or adapter dispatch",
  async (_name, change) => {
    let later = false;
    const h = await host([
      {
        id: "invalid",
        setup(tessar) {
          tessar.hook(
            "provider.request",
            (event) => change(event.payload) as any,
          );
        },
      },
      {
        id: "later",
        setup(tessar) {
          tessar.hook("provider.request", () => {
            later = true;
          });
        },
      },
    ]);
    try {
      const result = await h.agent.generate("hello");
      expect(result).toMatchObject({
        status: "failed",
        error: { code: "InvalidHookResult" },
      });
      expect(h.model.bodies).toEqual([]);
      expect(later).toBe(false);
    } finally {
      await h.controller.dispose();
    }
  },
);

it("preserves plugin error provenance and does not fall back to the original request", async () => {
  const failure = new Error("request policy failed");
  const h = await host([
    {
      id: "broken",
      setup(tessar) {
        tessar.hook("provider.request", () => {
          throw failure;
        });
      },
    },
  ]);
  try {
    const result = await h.agent.generate("hello");
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({
      message: failure.message,
      source: "plugin",
      pluginId: "broken",
    });
    expect(errorInfo(failure)).toMatchObject({
      source: "plugin",
      pluginId: "broken",
      eventId: "provider.request",
    });
    expect(h.model.bodies).toEqual([]);
  } finally {
    await h.controller.dispose();
  }
});

it("correlates concurrent auxiliary requests without applying primary context hooks", async () => {
  let contexts = 0;
  const requests: { attemptId: string; purpose: string }[] = [];
  const h = await host([
    {
      id: "auxiliary",
      setup(tessar) {
        tessar.hook("context.prepare", () => {
          contexts++;
        });
        tessar.hook("provider.request", async (event) => {
          await Promise.resolve();
          requests.push({
            attemptId: event.payload.attemptId,
            purpose: event.payload.purpose,
          });
        });
        tessar.hook("turn.decision", async (_event, ctx) => {
          const model = { providerId: "native", modelId: "fixture" };
          await Promise.all(
            ["first", "second"].map(async (task) => {
              for await (const _chunk of ctx.models.stream({
                model,
                instructions: buildInstruction([{ id: "task", content: task }]),
                messages: [],
                tools: [],
              })) {
                /* Consume the auxiliary call. */
              }
            }),
          );
        });
      },
    },
  ]);
  try {
    await h.agent.generate("hello");
    expect(contexts).toBe(1);
    expect(requests.map((r) => r.purpose).sort()).toEqual([
      "auxiliary",
      "auxiliary",
      "primary",
    ]);
    expect(new Set(requests.map((r) => r.attemptId)).size).toBe(3);
    expect(h.model.requests.slice(1).map((r) => r.messages)).toEqual([[], []]);
  } finally {
    await h.controller.dispose();
  }
});

it("runs a child Agent's selected context plugin without inheriting its parent's hooks", async () => {
  const seen: string[] = [];
  const child = await host([
    {
      id: "child-context",
      setup(tessar) {
        tessar.hook("context.prepare", (event) => {
          seen.push("child");
          return { ...event.payload, options: { temperature: 0.2 } };
        });
      },
    },
  ]);
  const parent = await host([
    {
      id: "delegate",
      setup(tessar) {
        tessar.hook("context.prepare", () => {
          seen.push("parent");
        });
        tessar.hook("turn.decision", async () => {
          await child.agent.generate("independent task");
        });
      },
    },
  ]);
  try {
    await parent.agent.generate("hello");
    expect(seen).toEqual(["parent", "child"]);
    expect(child.model.requests[0]!.options).toEqual({ temperature: 0.2 });
    expect(child.model.requests[0]!.messages).toHaveLength(1);
  } finally {
    await parent.controller.dispose();
    await child.controller.dispose();
  }
});
