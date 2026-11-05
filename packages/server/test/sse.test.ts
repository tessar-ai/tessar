import { afterEach, expect, test } from "vitest";
import { Agent } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { start } from "./helpers.js";
import type { Tessar } from "../src/index.js";
import { EventEnvelope, stateChanged, type RuntimeState } from "@tessar/core";
import { LatestStateWriter } from "../src/http/sse.js";
let server: { shutdown(): Promise<void> };
afterEach(async () => { await server?.shutdown(); });

test("slow writes retain only the newest pending snapshot", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const written: number[] = [];
  const writer = new LatestStateWriter(async event => { written.push(event.sequence!); await gate; });
  for (let sequence = 1; sequence <= 1000; sequence++) writer.push(new EventEnvelope(stateChanged,
    { state: {} as RuntimeState }, { sequence }));
  expect(written).toEqual([1]);
  writer.end(); release(); await writer.done;
  expect(written).toEqual([1, 1000]);
});

test("disconnect does not cancel or duplicate an Agent execution", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const model = new ScriptedProvider([{ text: "finished after disconnect", gate }]);
  const agent = new Agent({ id: crypto.randomUUID(), model });
  const host = await start({ agents: [agent] }); server = host.server;
  const response = await fetch(host.url + `/api/agents/${agent.id}/stream`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "question" }),
  });
  const reader = response.body!.getReader();
  const { value } = await reader.read();
  const first = new TextDecoder().decode(value);
  const frame = JSON.parse(first.split("data: ")[1]!.split("\n")[0]!);
  await reader.cancel(); release();
  const { data: session } = await host.request(`/api/controllers/${agent.id}/sessions`, "POST", {});
  const path = `/api/controllers/${agent.id}/sessions/${session.id}/threads/${frame.threadId}/streams`;
  await expect.poll(async () => (await host.request(path)).data.items[0]?.status).toBe("completed");
  expect(model.calls).toHaveLength(1);
});

test("Agent stream returns state envelopes and completes with one model call", async () => {
  const model = new ScriptedProvider([{ text: "answer" }]);
  const agent = new Agent({ id: crypto.randomUUID(), model });
  const host = await start({ agents: [agent] }); server = host.server;
  const response = await fetch(host.url + `/api/agents/${agent.id}/stream`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "question" }),
  });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const data = await response.text();
  expect(data).toContain("event: state_changed");
  expect(data).toContain('"payload":{"state":');
  expect(data).toContain("answer");
  expect(data).toContain('"status":"completed"');
  expect(model.calls).toHaveLength(1);
});

test("Session SSE initial snapshot and reconnect do not submit input", async () => {
  const host = await start(); server = host.server;
  const { data: [agent] } = await host.request("/api/agents");
  const c = `/api/controllers/${agent.controllerId}`;
  const { data: session } = await host.request(c + "/sessions", "POST", {});
  const s = c + "/sessions/" + session.id;
  for (let i = 0; i < 2; i++) {
    const response = await fetch(host.url + s + "/state/stream", { headers: { "Last-Event-ID": "old" } });
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('"status":"idle"');
    await reader.cancel();
  }
  expect((await host.request(s + "/queue")).data.count).toBe(0);
});

test("provider failure details are safe in state GET, execution records and SSE", async () => {
  const failure = Object.assign(new Error("sentinel secret credential"), { code: "NotFoundError", status: 404 });
  const model = new ScriptedProvider([{ error: failure }, { error: failure }]);
  const agent = new Agent({ id: crypto.randomUUID(), model });
  const host = await start({ agents: [agent] }); server = host.server;
  const streamed = await fetch(host.url + `/api/agents/${agent.id}/stream`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "fail" }),
  });
  const data = await streamed.text();
  expect(data).toContain('"source":"provider"'); expect(data).not.toContain("sentinel secret credential");
  const c = `/api/controllers/${agent.id}`;
  const { data: session } = await host.request(c + "/sessions", "POST", {});
  const s = c + "/sessions/" + session.id;
  const { data: thread } = await host.request(s + "/threads", "POST", {});
  await host.request(s + "/follow-up", "POST", { input: "fail" });
  await expect.poll(async () => (await host.request(s + "/state")).data.status).toBe("failed");
  expect(JSON.stringify((await host.request(s + "/state")).data)).not.toContain("sentinel secret credential");
  expect(JSON.stringify((await host.request(s + "/threads/" + thread.id + "/streams")).data)).not.toContain("sentinel secret credential");
});
