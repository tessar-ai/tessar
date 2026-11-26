import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTool, type ToolExecutionContext } from "../../src/tools/tool.js";
import { executeTool } from "../../src/engine/tool-executor.js";
import { TessarError } from "../../src/errors.js";

const definition = { name: "read", description: "Read", schema: z.object({}) };
const timeout = () => Object.assign(new Error("Operation timed out"), { code: "ETIMEDOUT" });
const context = (signal = new AbortController().signal) => ({ signal }) as ToolExecutionContext;

afterEach(() => vi.useRealTimers());

it("defaults to 250 ms between attempts and returns the last error at the limit", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const failure = timeout();
  const execute = vi.fn().mockRejectedValueOnce(timeout()).mockRejectedValueOnce(failure);
  const tool = createTool({ ...definition, retry: { maxRetries: 1 }, execute });
  const result = executeTool(tool, {}, context()).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(249);
  expect(execute).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe(failure);
  expect(execute).toHaveBeenCalledTimes(2);
});

it("cancels the retry timer and stops further attempts on abort", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const controller = new AbortController();
  const execute = vi.fn().mockRejectedValue(timeout());
  const tool = createTool({ ...definition, retry: { maxRetries: 3, delayMs: 500 }, execute });
  const result = executeTool(tool, {}, context(controller.signal)).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10);
  expect(vi.getTimerCount()).toBe(1);
  controller.abort("Esc");
  expect(await result).toMatchObject({ code: "RecoveryRequired" });
  expect(vi.getTimerCount()).toBe(0);
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each([
  new TypeError("Invalid input"),
  Object.assign(new Error("Permission denied"), { code: "EACCES" }),
  Object.assign(new Error("API rejected the request"), { status: 503 }),
  new Error("Request timed out"),
  new TessarError("StorageUnavailable", "Backend failed", { cause: timeout() }),
])("preserves unclassified and non-tool failures (%s)", async (failure) => {
  const execute = vi.fn().mockRejectedValue(failure);
  const tool = createTool({ ...definition, retry: { maxRetries: 2, delayMs: 0 }, execute });
  await expect(executeTool(tool, {}, context())).rejects.toBe(failure);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("attempts a tool without a retry policy once", async () => {
  const failure = timeout();
  const execute = vi.fn().mockRejectedValue(failure);
  await expect(executeTool(createTool({ ...definition, execute }), {}, context()))
    .rejects.toBe(failure);
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each([
  { maxRetries: -1 },
  { maxRetries: 1.5 },
  { maxRetries: 1, delayMs: Infinity },
  { maxRetries: 1, delayMs: -1 },
])("rejects invalid retry options (%j)", (retry) => {
  expect(() => createTool({ ...definition, retry, execute: () => "done" }))
    .toThrow(TessarError);
});
