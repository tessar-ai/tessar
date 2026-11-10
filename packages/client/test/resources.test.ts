import { expect, test, vi, expectTypeOf } from "vitest";
import { TessarClient } from "../src/index.js";
import type { ExecutionOptions, SessionOptions, AgentInfo, Serialized, ThreadClient } from "../src/index.js";
import type { ModelRef } from "@tessar/core";

test("handles are local and all runtime methods map to the existing routes", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ id: "created", items: [], nextCursor: "next" }));
  const client = new TessarClient({ baseURL: "http://test", fetch: fetcher });
  const agent = client.getAgent("a");
  const controller = client.getController("c");
  const session = controller.getSession("s");
  const thread = session.thread.get("t");
  expect(fetcher).not.toHaveBeenCalled();
  const A = "/api/agents/a", C = "/api/controllers/c", S = C + "/sessions/s", T = S + "/threads/t";
  const cases: [() => Promise<unknown>, string, string, unknown?][] = [
    [() => client.listAgents(), "GET", "/api/agents"],
    [() => client.listControllers(), "GET", "/api/controllers"],
    [() => agent.info(), "GET", A], [() => agent.listTool(), "GET", A + "/tools"],
    [() => agent.generate("hi", { model: "m" }), "POST", A + "/generate", { input: "hi", options: { model: "m" } }],
    [() => agent.sendSignal({ threadId: "t", content: "hey" }), "POST", A + "/signals", { threadId: "t", content: "hey" }],
    [() => agent.abort("run", { reason: "stop" }), "POST", A + "/streams/run/abort", { reason: "stop" }],
    [() => controller.info(), "GET", C],
    [() => controller.createSession({ id: "new" }), "POST", C + "/sessions", { id: "new" }],
    [() => controller.listSessions({ limit: 2 }), "GET", C + "/sessions?limit=2"],
    [() => controller.records.append({ namespace: "notes", data: { a: 1 } }), "POST", C + "/records/notes", { data: { a: 1 } }],
    [() => controller.records.get("notes", "r"), "GET", C + "/records/notes/r"],
    [() => controller.records.list({ namespace: "notes", limit: 2 }), "GET", C + "/records/notes?limit=2"],
    [() => session.info(), "GET", S], [() => session.close(), "POST", S + "/close", {}],
    [() => session.followUp("hi"), "POST", S + "/follow-up", { input: "hi" }],
    [() => session.resume({ interruptId: "i", value: true }), "POST", S + "/resume", { interruptId: "i", value: true }],
    [() => session.recover({ streamId: "run" }), "POST", S + "/recover", { streamId: "run" }],
    [() => session.abort(), "POST", S + "/abort", {}],
    [() => session.queue.info(), "GET", S + "/queue"],
    [() => session.model.info(), "GET", S + "/model"], [() => session.model.list(), "GET", S + "/models"],
    [() => session.model.switch("m", { options: { temperature: 0 } }), "POST", S + "/model/switch", { modelId: "m", options: { temperature: 0 } }],
    [() => session.model.setEffort("low"), "POST", S + "/model/effort", { level: "low" }],
    [() => session.state.get(), "GET", S + "/state"],
    [() => session.thread.create({ title: "chat" }), "POST", S + "/threads", { title: "chat" }],
    [() => session.thread.list(), "GET", S + "/threads"],
    [() => session.thread.switch("t"), "POST", S + "/thread/switch", { threadId: "t" }],
    [() => session.thread.rename("title", { threadId: "t" }), "POST", T + "/rename", { title: "title" }],
    [() => session.thread.fork({ threadId: "t", id: "f" }), "POST", T + "/fork", { id: "f" }],
    [() => session.thread.delete({ threadId: "t" }), "DELETE", T],
    [() => session.thread.purge({ threadId: "t" }), "POST", T + "/purge", {}],
    [() => thread.info(), "GET", T], [() => thread.snapshot(), "GET", T + "/snapshot"],
    [() => thread.getHistory({ atCheckpointId: "cp" }), "GET", T + "/history?atCheckpointId=cp"],
    [() => thread.listCheckpoints(), "GET", T + "/checkpoints"],
    [() => thread.getCheckpoint("cp"), "GET", T + "/checkpoints/cp"],
    [() => thread.getStream("run"), "GET", T + "/streams/run"],
    [() => thread.getInterrupt("i"), "GET", T + "/interrupts/i"],
    [() => thread.listStreams({ status: "failed", cursor: "next" }), "GET", T + "/streams?status=failed&cursor=next"],
    [() => thread.listTurns(), "GET", T + "/turns"],
    [() => thread.listModelAttempts(), "GET", T + "/model-attempts"],
    [() => thread.listToolExecutions(), "GET", T + "/tool-executions"],
    [() => thread.listInterrupts(), "GET", T + "/interrupts"],
  ];
  for (const [call, method, path, body] of cases) {
    fetcher.mockClear();
    const result = await call();
    expect(fetcher, path).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url), path).toBe("http://test" + path);
    expect(init!.method, path).toBe(method);
    expect(init!.body === undefined ? undefined : JSON.parse(String(init!.body)), path).toEqual(body);
    if (result && typeof result === "object" && "nextCursor" in result) expect(result.nextCursor).toBe("next");
  }
  expect((await controller.createSession()).id).toBe("created");
  expect((await session.thread.create()).id).toBe("created");
  expect((await session.thread.switch("t")).id).toBe("created");
});

test("request cancellation is never serialized into execution/domain bodies", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
  const agent = new TessarClient({ baseURL: "http://test", fetch: fetcher }).getAgent("a");
  const signal = new AbortController().signal;
  await agent.generate("hi", { signal });
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ signal, body: '{"input":"hi","options":{}}' });
});

test("public remote types exclude executable adapters", () => {
  expectTypeOf<ExecutionOptions["model"]>().toEqualTypeOf<string | ModelRef | undefined>();
  expectTypeOf<SessionOptions["model"]>().not.toBeAny();
  expectTypeOf<AgentInfo["id"]>().toEqualTypeOf<string>();
  expectTypeOf<Serialized<{ createdAt: Date; method(): void }>>().toEqualTypeOf<{ createdAt: string }>();
  expectTypeOf<Awaited<ReturnType<ThreadClient["snapshot"]>>>().toHaveProperty("activeStreamId");
  expectTypeOf<Awaited<ReturnType<ThreadClient["snapshot"]>>>().toHaveProperty("currentCheckpointId");
  expectTypeOf<Awaited<ReturnType<ThreadClient["snapshot"]>>>().toHaveProperty("usage");
});
