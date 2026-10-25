import {
  createThread,
  getThread,
} from "../../packages/core/src/state/thread-operations.js";
import { z } from "zod";
import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  Controller,
  HumanMessage,
  AssistantMessage,
  MessageCodec,
  createTool,
  defineInterruption,
  ToolDecision,
  turn,
  stream,
  type Session,
  type Plugin,
} from "@tessar/core";
import { OpenAIProvider } from "@tessar/openai";
import { AgentHarness } from "@tessar/core/testing";
import { createSqliteBackend, SqliteStoragePlugin } from "@tessar/sqlite";

function completion(api: string, id: number) {
  const data =
    api === "responses"
      ? [
          {
            type: "response.completed",
            response: {
              id: "response_" + id,
              output: [
                {
                  id: "msg_" + id,
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: "persisted answer",
                      annotations: [],
                    },
                  ],
                },
              ],
            },
          },
        ]
      : [
          {
            id: "chat_" + id,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "persisted answer" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chat_" + id,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ];
  return new Response(
    data.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") +
      (api === "responses" ? "" : "data: [DONE]\n\n"),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
async function send(session: Session, input: string | HumanMessage) {
  const done = new Promise<any>((resolve, reject) => {
    const off = session.subscribe((event) => {
      if (event.type === stream.end) {
        off();
        resolve(event.payload);
      }
      if (event.type === stream.error) {
        off();
        reject(event.payload);
      }
    });
  });
  await session.followUp(
    typeof input === "string" ? new HumanMessage(input) : input,
  );
  const result = await done;
  await session.dispose();
  return result;
}
for (const api of ["responses", "chat-completions"] as const)
  it(`${api} restores Session, history and options in new runtime objects`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "tessar-restart-")),
      filename = join(directory, "state.db");
    const requests: any[] = [];
    async function open(
      baseURL = "https://fixture.test/v1",
      connectionId = "primary",
    ) {
      const model = new OpenAIProvider({
        api,
        connectionId,
        model: "fixture",
        apiKey: "fixture-secret",
        baseURL,
        temperature: 0.25,
        fetch: async (_url, init) => {
          requests.push(JSON.parse(init!.body as string));
          return completion(api, requests.length);
        },
      });
      const controller = new Controller({
        id: "app",
        agent: new Agent({ id: "assistant", model }),
        plugins: [new SqliteStoragePlugin({ filename })],
      });
      await controller.initialize();
      return controller;
    }
    let controller = await open();
    try {
      const session = await controller.createSession({
        id: "application-session",
        scope: { user: "a" },
        metadata: { label: "work" },
      });
      const thread = await session.thread.create({
        id: "application-thread",
        title: "Conversation",
      });
      const fork = await session.thread.fork({ id: "application-fork" });
      expect(fork.id).toBe("application-fork");
      const first = new HumanMessage([
        { type: "text", text: "first question" },
        {
          type: "text",
          text: "\n\nadditional context",
          metadata: {
            source: "application",
            custom: { labels: ["reference"] },
          },
        },
      ]);
      session.subscribe("input.received", (event) => {
        expect(event.payload.messages).toEqual([MessageCodec.encode(first)]);
      });
      expect((await send(session, first)).status).toBe("completed");
      await controller.dispose();
      controller = await open();
      const restored = (await controller.getSession(session.id, {
        scope: { user: "a" },
      }))!;
      expect(restored.id).toBe("application-session");
      expect((await restored.thread.get("application-fork"))!.id).toBe(
        "application-fork",
      );
      expect(restored.thread.getId()).toBe(thread.id);
      const history = (await restored.thread.getHistory()).items;
      expect(history).toHaveLength(2);
      expect(history.find((message) => message.id === first.id)).toEqual(
        MessageCodec.encode(first),
      );
      const snapshot = await (await restored.thread.get(thread.id))!.snapshot();
      expect(
        snapshot.state.messages.find((message) => message.id === first.id),
      ).toEqual(MessageCodec.encode(first));
      expect((await send(restored, "next question")).status).toBe("completed");
      expect(requests).toHaveLength(2);
      expect(requests[1].temperature).toBe(0.25);
      expect(JSON.stringify(requests[1])).toContain("first question");
      expect(JSON.stringify(requests[1])).toContain("additional context");
      expect(JSON.stringify(requests[1])).not.toContain('"metadata"');
      expect(JSON.stringify(requests[1])).toContain("persisted answer");
      const stored = await controller.backend.sessions.get(session.id);
      expect(JSON.stringify(stored)).not.toContain("fixture-secret");
      expect(stored?.selectedModel.ref.connectionId).toBe("primary");
      await controller.dispose();
      controller = await open("https://changed.test/v1");
      expect(
        await controller.getSession(session.id).then(
          () => null,
          (error) => error.code,
        ),
      ).toBe("ModelContextIncompatible");
      expect(requests).toHaveLength(2);
    } finally {
      await controller.dispose();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });

it("reopens a suspended Session with summary state and does not replay its completed tool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tessar-suspended-")),
    filename = join(directory, "state.db");
  let executions = 0;
  const approval = defineInterruption({
    id: "continue",
    version: 1,
    response: { jsonSchema: {}, parse: () => ({}) },
    resolve: () => ToolDecision.allow(),
  });
  const plugin = (configurationId = "v1"): Plugin => ({
    id: "summary",
    configurationId,
    setup(tessar) {
      const state = tessar.state.define({
        namespace: "context",
        schemaVersion: 1,
        initial: { summary: "", throughMessageId: "" },
      });
      tessar.tools.register(
        createTool({
          name: "work",
          description: "work",
          schema: z.object({}),
          execute: () => {
            executions++;
            return "done";
          },
        }),
      );
      tessar.interruptions.register(approval);
      tessar.hook(turn.decision, async (event, context) => {
        if (!event.payload.hadTools) return;
        context.state.update(state, {
          summary: "Work completed",
          throughMessageId: "tool-result",
        });
        const owned = context.state.owned({
          type: "session",
          id: context.session!.id,
        });
        await owned.update(state, 0, {
          summary: "Session note",
          throughMessageId: "tool-result",
        });
        return context.suspend(approval, {});
      });
    },
  });
  async function open(resumed = false, configurationId = "v1") {
    return AgentHarness.create({
      backend: await createSqliteBackend({ filename }),
      plugins: [plugin(configurationId)],
      modelScripts: resumed
        ? [{ text: "finished" }]
        : [
            {
              response: {
                message: MessageCodec.encode(
                  new AssistantMessage([
                    {
                      type: "tool-call",
                      toolCallId: "call",
                      name: "work",
                      arguments: {},
                    },
                  ]),
                ),
              },
            },
          ],
    });
  }
  let h = await open();
  try {
    const session = await h.controller.createSession(),
      thread = await session.thread.create();
    const suspended = new Promise<any>((resolve) =>
      session.subscribe(stream.suspended, resolve),
    );
    await session.followUp(new HumanMessage("work"));
    const pending = await suspended;
    await session.dispose();
    await h.dispose();
    h = await open(true, "changed");
    let restored = (await h.controller.getSession(session.id))!;
    expect(
      await restored
        .resume({ interruptId: pending.payload.interrupt.id, value: {} })
        .then(
          () => null,
          (e) => e.code,
        ),
    ).toBe("ResumeIncompatible");
    expect(h.provider.calls).toHaveLength(0);
    await h.dispose();
    h = await open(true);
    restored = (await h.controller.getSession(session.id))!;
    const done = new Promise<any>((resolve) =>
      restored.subscribe(stream.end, resolve),
    );
    const receipt = await restored.resume({
      interruptId: pending.payload.interrupt.id,
      value: {},
    });
    expect(receipt.streamId).toBe(pending.streamId);
    await done;
    await restored.dispose();
    if (process.env.TESSAR_SAMPLE_PATH) {
      const db = new DatabaseSync(filename);
      try {
        const tables = [
          "sessions",
          "threads",
          "checkpoints",
          "messages",
          "streams",
          "turns",
          "model_attempts",
          "tool_executions",
          "interrupts",
          "staging",
          "commits",
          "leases",
          "owned_states",
        ];
        const sample = Object.fromEntries(
          tables.map((table) => [
            table,
            {
              count: Number(
                db.prepare("SELECT count(*) n FROM tessar_" + table).get()!.n,
              ),
              rows: db
                .prepare(
                  "SELECT * FROM tessar_" +
                    table +
                    ([
                      "messages",
                      "streams",
                      "turns",
                      "model_attempts",
                      "tool_executions",
                      "interrupts",
                    ].includes(table)
                      ? " WHERE to_revision IS NULL"
                      : "") +
                    " LIMIT 2",
                )
                .all()
                .map((row) =>
                  row.body
                    ? { ...row, body: JSON.parse(String(row.body)) }
                    : row,
                ),
            },
          ]),
        );
        await writeFile(
          process.env.TESSAR_SAMPLE_PATH,
          JSON.stringify(sample, null, 2),
        );
      } finally {
        db.close();
      }
    }
    expect(executions).toBe(1);
    expect(h.provider.calls[0]!.messages.some((m) => m.role === "tool")).toBe(
      true,
    );
    expect(
      (await h.checkpoint(thread.id)).state.pluginStates.find(
        (s) => s.pluginId === "summary",
      )?.data,
    ).toEqual({ summary: "Work completed", throughMessageId: "tool-result" });
  } finally {
    await h.dispose();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

it.each(["endpoint", "protocol"])(
  "rejects changed %s before resuming a Thread with no assistant history",
  async (change) => {
    const directory = await mkdtemp(join(tmpdir(), "tessar-binding-")),
      filename = join(directory, "state.db");
    let calls = 0;
    const approval = defineInterruption({
      id: "bind",
      version: 1,
      response: { jsonSchema: {}, parse: () => ({}) },
      resolve: () => ToolDecision.allow(),
    });
    async function open(changed = false) {
      const api =
        changed && change === "protocol" ? "chat-completions" : "responses";
      const model = new OpenAIProvider({
        api,
        connectionId: "same",
        model: "fixture",
        apiKey: "fixture",
        baseURL:
          changed && change === "endpoint"
            ? "https://new.test/v1"
            : "https://old.test/v1",
        fetch: async () => {
          calls++;
          return completion(api, calls);
        },
      });
      const controller = new Controller({
        id: "app",
        agent: new Agent({ id: "app", model }),
        plugins: [
          new SqliteStoragePlugin({ filename }),
          {
            id: "approval",
            setup(tessar) {
              tessar.interruptions.register(approval);
              tessar.hook(stream.before, (_e, c) => c.suspend(approval, {}));
            },
          },
        ],
      });
      await controller.initialize();
      return controller;
    }
    let controller = await open();
    try {
      const thread = await createThread(controller);
      let pending: any;
      const model = controller.agent.getModel();
      for await (const event of thread.stream({
        input: new HumanMessage("pause"),
        model: "ref" in model ? model.ref : model,
      }))
        if (event.type === stream.suspended) pending = event.payload.interrupt;
      await controller.dispose();
      controller = await open(true);
      const restored = (await getThread(controller, thread.id))!;
      let error: string | undefined;
      for await (const event of restored.stream({
        resume: { interruptId: pending.id, value: {} },
      }))
        if (event.type === stream.error) error = event.payload.error.code;
      expect(error).toBe("ModelContextIncompatible");
      expect(calls).toBe(0);
      expect(
        (
          await controller.queries.getRecord(
            "interrupts",
            thread.id,
            pending.id,
          )
        )?.status,
      ).toBe("pending");
    } finally {
      await controller.dispose();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
);
