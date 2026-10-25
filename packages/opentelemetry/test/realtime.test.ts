import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { AssistantMessage, MessageCodec, createTool } from "@tessar/core";
import { AgentHarness } from "@tessar/core/testing";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenTelemetryPlugin, type TraceAdapter } from "../src/index.js";

it.each([undefined, false, true])("exports completed spans with realtime=%s while leaving active spans open", async (realtime) => {
  vi.stubEnv("OTEL_BSP_SCHEDULE_DELAY", "60000");
  vi.stubEnv("OTEL_BSP_MAX_EXPORT_BATCH_SIZE", "512");
  const destinations = [[], []] as ReadableSpan[][];
  const adapters: TraceAdapter[] = destinations.map((spans) => ({
    createExporter: () => ({
      export: (batch, done) => { spans.push(...batch); done({ code: 0 }); },
      async shutdown() {},
    }),
  }));
  let entered!: () => void, release!: () => void;
  const enteredTool = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const wait = createTool({
    name: "wait", description: "Wait for the test", schema: z.object({}),
    execute: async () => { entered(); await gate; return "tool result"; },
  });
  let harness: AgentHarness | undefined;
  let done: Promise<unknown> | undefined;
  try {
    harness = await AgentHarness.create({
      tools: { wait },
      modelScripts: [{ response: { message: MessageCodec.encode(new AssistantMessage([
        { type: "tool-call", name: "wait", toolCallId: "wait-call", arguments: {} },
      ])) } }, { text: "answer" }],
      plugins: [new OpenTelemetryPlugin({ adapters, ...(realtime === undefined ? {} : { realtime }) })],
    });
    done = harness.collect(harness.agent.stream("Wait then answer"));
    void done.catch(() => {});
    await enteredTool;
    if (realtime) {
      await vi.waitFor(() => {
        for (const spans of destinations) {
          expect(spans.map((span) => span.name)).toEqual(["test"]);
          expect(spans.every((span) => span.ended)).toBe(true);
        }
      }, { timeout: 500, interval: 10 });
    } else {
      expect(destinations).toEqual([[], []]);
    }
    release();
    await done;
    if (!realtime) expect(destinations).toEqual([[], []]);
  } finally {
    release();
    try { await done; }
    finally {
      try { await harness?.dispose(); }
      finally { vi.unstubAllEnvs(); }
    }
  }
  for (const spans of destinations) {
    expect(spans.filter((span) => span.name === "test")).toHaveLength(2);
    expect(spans.some((span) => span.name === "wait")).toBe(true);
    expect(spans.some((span) => span.name === "test-agent")).toBe(true);
    expect(new Set(spans.map((span) => span.spanContext().spanId)).size).toBe(spans.length);
  }
  expect(destinations[0]!.map((span) => span.spanContext().spanId).sort()).toEqual(
    destinations[1]!.map((span) => span.spanContext().spanId).sort(),
  );
});
