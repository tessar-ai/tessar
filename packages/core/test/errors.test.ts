import { expect, it } from "vitest";
import { z } from "zod";
import { errorFromInfo, errorInfo, TessarError } from "../src/errors.js";
import { AgentHarness } from "../src/testing/harness.js";
import { createMemoryBackend } from "../src/state/memory-backend.js";
import { guardStorage } from "../src/state/storage-errors.js";
import { providerCall } from "../src/models/stream.js";
import { PluginHost } from "../src/plugins/host.js";
import { executeTool } from "../src/engine/tool-executor.js";
import { createTool, type ToolExecutionContext } from "../src/tools/tool.js";
import type { ErrorInfo } from "../src/errors.js";

class PluginFailure extends TessarError {
  readonly name = "PluginFailure";
  constructor(readonly operation: string) {
    super("PluginFailure", "Plugin operation failed", {
      source: "plugin", details: { operation },
    });
  }
}
class OtherFailure extends TessarError {}

it("inherits a class-specific instance guard without using names or constructing errors", () => {
  const error: unknown = new PluginFailure("read");
  expect(TessarError.isInstance(error)).toBe(true);
  expect(PluginFailure.isInstance(error)).toBe(true);
  expect(OtherFailure.isInstance(error)).toBe(false);
  expect(PluginFailure.isInstance(new TessarError("test", "base"))).toBe(false);
  const SameName = class PluginFailure extends TessarError {};
  expect(PluginFailure.isInstance(new SameName("other", "same name"))).toBe(false);
  class Descendant extends PluginFailure { readonly additional = true; }
  expect(PluginFailure.isInstance(new Descendant("write"))).toBe(true);
  expect(Descendant.isInstance(error)).toBe(false);
  expect(Object.hasOwn(PluginFailure, "isInstance")).toBe(false);
});

it("returns false safely for unknown inputs, lookalikes and hostile prototype lookups", () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const value of [
    undefined, null, false, 0, "error", Symbol("error"), {}, new Error("native"),
    { name: "TessarError", code: "test", message: "lookalike" },
    new Proxy({}, { getPrototypeOf() { throw Error("no prototype access"); } }), revoked.proxy,
  ]) expect(TessarError.isInstance(value)).toBe(false);
});

it("keeps native causes and declared source separate from hierarchy and boundary attribution", () => {
  const cause = Error("underlying");
  const error = new TessarError("OperationFailed", "Failed", {
    source: "application", details: { operation: "save" }, cause,
  });
  expect(error.cause).toBe(cause);
  expect(error.stack).toContain("Failed");
  expect(errorInfo(error, { source: "plugin", pluginId: "outer" })).toMatchObject({
    source: "application", code: "OperationFailed", details: { operation: "save" },
  });
  expect(errorInfo(new PluginFailure("read"))).toMatchObject({ source: "plugin", name: "PluginFailure" });
  const info = JSON.parse(JSON.stringify(new TessarError("InvalidData", "Bad", { details: { field: "x" } })));
  expect(TessarError.isInstance(info)).toBe(false);
  expect(errorFromInfo(info)).toMatchObject({ code: "InvalidData", details: { field: "x" }, source: "tessar" });
});

it.each(["tessar", "provider"] as const)("attributes %s errors without changing their declared source", async (source) => {
  class BoundaryFailure extends TessarError {
    constructor() { super(source === "provider" ? "StorageUnavailable" : "InvalidData", "Operation failed", { source }); }
  }
  const providerError = new BoundaryFailure();
  expect(() => providerCall({ providerId: "custom", modelId: "model" }, () => { throw providerError; })).toThrow(providerError);
  expect(errorInfo(providerError)).toMatchObject({ source, providerId: "custom", modelId: "model" });

  const backend = createMemoryBackend();
  const storageError = new BoundaryFailure();
  backend.records.append = async () => { throw storageError; };
  try {
    await expect(guardStorage(backend).records.append({ namespace: "audit", data: {} })).rejects.toBe(storageError);
    expect(errorInfo(storageError)).toMatchObject({ source, backendId: backend.id });
  } finally { await backend.close(); }

  const toolError = new BoundaryFailure();
  const tool = createTool({
    name: "read", description: "Read", schema: z.object({}),
    execute() { throw toolError; },
  });
  await expect(executeTool(tool, {}, {
    signal: new AbortController().signal,
  } as ToolExecutionContext)).rejects.toBe(toolError);
  expect(errorInfo(toolError)).toMatchObject({ source, toolName: "read" });

  const diagnostics: ErrorInfo[] = [];
  const host = new PluginHost({ diagnostics: (info) => { diagnostics.push(info); } });
  try {
    await host.attach({ id: "provider-hook", setup(tessar) {
      tessar.hook("ready", () => { throw new BoundaryFailure(); });
    } });
    // A reserved framework code from a provider must remain a notification failure.
    await expect(host.dispatch("ready", { agentId: "agent" })).resolves.toBeUndefined();
    expect(diagnostics[0]).toMatchObject({ source, pluginId: "provider-hook", eventId: "ready" });
    const setupError = new BoundaryFailure();
    await expect(host.attach({ id: "provider-setup", setup() { throw setupError; } })).rejects.toBe(setupError);
    expect(diagnostics[1]).toMatchObject({ source, pluginId: "provider-setup" });
  } finally { await host.dispose(); }
});

it.each(["StorageUnavailable", "CommitConflict", "OwnershipLost"])("propagates framework %s from notification hooks", async (code) => {
  const error = new TessarError(code, "Recovery required");
  const host = new PluginHost();
  try {
    await host.attach({ id: "recovery", setup(tessar) {
      tessar.hook("ready", () => { throw error; });
    } });
    await expect(host.dispatch("ready", { agentId: "agent" })).rejects.toBe(error);
  } finally { await host.dispose(); }
});

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
      ["records", "append"], ["records", "get"], ["records", "list"],
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
