import { expect, it } from "vitest";
import { errorInfo, TessarError } from "../src/errors.js";
import { AgentHarness } from "../src/testing/harness.js";
import { createMemoryBackend } from "../src/state/memory-backend.js";
import { guardStorage } from "../src/state/storage-errors.js";

it("supports frozen custom storage ports", async () => {
  const backend = createMemoryBackend();
  Object.freeze(backend.sessions);
  const guarded = guardStorage(backend);
  try { await expect(guarded.sessions.get("missing")).resolves.toBeNull(); }
  finally { await guarded.close(); }
});

it("keeps storage provenance when a registered backend fails during plugin cleanup", async () => {
  const h = await AgentHarness.create();
  const original = h.backend.close;
  const error = Error("Storage close failed");
  h.backend.close = async () => { throw error; };
  try {
    await h.dispose();
    expect(errorInfo(error)).toMatchObject({ source: "storage", backendId: h.backend.id });
  } finally { await original(); }
});

it("marks failures from every registered storage port without replacing the exception", async () => {
  const h = await AgentHarness.create();
  try {
    const operations = [
      ["sessions", "get"], ["ownedState", "get"], ["threads", "get"],
      ["checkpoints", "get"], ["executions", "get"], ["ownership", "acquire"], ["commits", "lookupCommit"],
    ] as const;
    for (const [port, method] of operations) {
      const error = Object.assign(new Error("Offline"), { code: "ECONNRESET" });
      const raw = h.backend[port] as any, original = raw[method];
      raw[method] = async () => { throw error; };
      try {
        await expect((h.controller.backend[port] as any)[method]("missing")).rejects.toBe(error);
        expect(errorInfo(error)).toMatchObject({ source: "storage", backendId: h.backend.id, code: "ECONNRESET" });
      } finally { raw[method] = original; }
    }
  } finally { await h.dispose(); }
});

it("retains the provider origin and SDK fields across outer catches", () => {
  const error = Object.assign(new Error("Rate limited"), {
    name: "RateLimitError",
    code: "rate_limit_exceeded",
    status: 429,
    request_id: "request-1",
  });
  expect(
    errorInfo(error, {
      source: "provider",
      providerId: "openai",
      modelId: "x",
    }),
  ).toMatchObject({
    source: "provider",
    providerId: "openai",
    modelId: "x",
    name: "RateLimitError",
    code: "rate_limit_exceeded",
    message: "Rate limited",
    details: { status: 429, request_id: "request-1" },
  });
  expect(errorInfo(error).source).toBe("provider");
});

it("identifies framework errors and plain core exceptions without an unknown source", () => {
  expect(new TessarError("ThreadBusy", "Busy").toJSON()).toMatchObject({
    source: "tessar",
    code: "ThreadBusy",
  });
  expect(errorInfo(new TypeError("Core bug"))).toMatchObject({
    source: "tessar",
    name: "TypeError",
    code: "TypeError",
  });
});
