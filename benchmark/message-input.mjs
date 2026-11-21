import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { HumanMessage, MessageCodec } from "@tessar/core";
import { inputMessages } from "../packages/core/dist/messages/codec.js";

const MESSAGE_COUNT = 100;
const TEXT_SIZE = 1024;
const ITERATIONS = 20;
const WARMUPS = 2;
const SAMPLES = 5;
const messages = Array.from({ length: MESSAGE_COUNT }, (_, index) => new HumanMessage("x".repeat(TEXT_SIZE), {
  id: "input-" + index, metadata: { file: "manual.md", tags: ["one", "two"] },
  providerState: { vendor: { token: "value" } },
}));
const results = [];
for (const [name, input] of [["message-classes", messages], ["wire-messages", messages.map(MessageCodec.encode)]]) {
  const samples = [];
  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    globalThis.gc?.();
    let output;
    const started = performance.now();
    for (let iteration = 0; iteration < ITERATIONS; iteration++) output = inputMessages(input);
    const elapsedMs = performance.now() - started;
    assert.equal(output.length, MESSAGE_COUNT);
    assert.equal(Object.getPrototypeOf(output[0]), Object.prototype);
    assert.equal(output[0].content[0].text, "x".repeat(TEXT_SIZE));
    assert.deepEqual(output[0].metadata, { file: "manual.md", tags: ["one", "two"] });
    assert.ok(Object.isFrozen(output[0].metadata.tags));
    if (sample >= 0) samples.push(elapsedMs);
  }
  results.push({ name, messagesPerSample: MESSAGE_COUNT * ITERATIONS, samples,
    medianMs: [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] });
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, results }, null, 2));
