import { expect, it } from "vitest";
import { ModelRegistry } from "../../src/models/registry.js";
import { selectAdapter } from "../../src/models/stream.js";
import { PluginHost } from "../../src/plugins/host.js";
import type { ModelAdapter, ModelRef } from "../../src/models/contract.js";

const ref = {
  providerId: "expected",
  modelId: "wanted",
  connectionId: "connection",
};
const adapter = (value: ModelRef): ModelAdapter => ({
  ref: value,
  validate() {},
  async *stream() {},
});

it.each([
  { ...ref, providerId: "wrong" },
  { ...ref, modelId: "wrong" },
  { ...ref, connectionId: "wrong" },
])(
  "rejects incorrect adapter identity in both registry and execution selection: %j",
  async (value) => {
    const registration = { id: ref.providerId, create: () => adapter(value) };
    const registry = new ModelRegistry();
    registry.registerProvider(registration);
    const host = new PluginHost();
    await host.attach({
      id: "provider",
      setup(tessar) {
        tessar.models.register(registration);
      },
    });
    const lease = host.capture();
    try {
      expect(() => registry.resolve(ref)).toThrowError(
        expect.objectContaining({ code: "ModelContextIncompatible" }),
      );
      expect(() => selectAdapter(lease, ref)).toThrowError(
        expect.objectContaining({ code: "ModelContextIncompatible" }),
      );
    } finally {
      registry.dispose();
      await lease.release();
      await host.dispose();
    }
  },
);

it("validates withModel results before executing a retained adapter", async () => {
  const original: ModelAdapter = {
    ...adapter({ ...ref, modelId: "original" }),
    withModel: () => adapter({ ...ref, modelId: "wrong" }),
  };
  const host = new PluginHost();
  const lease = host.capture();
  try {
    expect(() => selectAdapter(lease, ref, original)).toThrowError(
      expect.objectContaining({ code: "ModelContextIncompatible" }),
    );
  } finally {
    await lease.release();
    await host.dispose();
  }
});
