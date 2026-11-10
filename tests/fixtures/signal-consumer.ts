import assert from "node:assert/strict";
import {
  Agent, AssistantMessage, Controller, MessageCodec,
  type ModelAdapter, type ModelRequest, type ModelChunk, type SendSignalOptions,
} from "@tessar/core";

// A consumer of built package exports, without internal admission/test helpers.
const calls: ModelRequest[] = [];
let start!: () => void, release!: () => void;
const started = new Promise<void>((done) => { start = done; });
const gate = new Promise<void>((done) => { release = done; });
const model: ModelAdapter = {
  ref: { providerId: "fixture", modelId: "local" },
  validate() { },
  async *stream(request): AsyncIterable<ModelChunk> {
    calls.push(request);
    if (calls.length === 1) { start(); await gate; }
    yield { type: "response", response: { message: MessageCodec.encode(new AssistantMessage("answer")) } };
  },
};
const agent = new Agent({ id: "signal-public", model });
try {
  const stream = agent.stream("hello", { id: "direct" });
  const done = (async () => {
    for await (const event of stream) {
      assert.notEqual(event.type, "stream.error");
      assert.equal(event.streamId, "direct");
    }
  })();
  await started;
  const options: SendSignalOptions = {
    streamId: stream.id!, content: "build finished", tagName: "notification",
    attributes: { source: "github", pr: 123 }, metadata: { hidden: true },
  };
  await agent.sendSignal(options);
  release(); await done;
  assert.equal(calls.length, 2);
  assert.ok(JSON.stringify(calls[1]!.messages).includes("build finished"));

  const controller = new Controller({ id: "signal-public", agent });
  await controller.initialize();
  try {
    const session = await controller.createSession({ id: "session" });
    const thread = await session.thread.create({ id: "thread" });
    assert.equal("sendSignal" in session, false);
    assert.equal("runId" in stream, false);
    const completed = new Promise<void>((resolve, reject) => {
      session.subscribe((event) => {
        if (event.type === "stream.end") resolve();
        if (event.type === "stream.error") reject(event.payload.error);
      });
    });
    await agent.sendSignal({ threadId: session.thread.getId()!, content: "session notification", persist: false });
    await completed;
    assert.equal(calls.length, 3);
    assert.ok(JSON.stringify(calls[2]!.messages).includes("session notification"));
    assert.ok(!JSON.stringify(await thread.getHistory()).includes("session notification"));
    await session.dispose();
  } finally { await controller.dispose(); }
} finally { release(); await agent.shutdown(); }
