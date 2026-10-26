import { expect, it } from "vitest";
import { OpenAIPlugin } from "../src/plugin.js";
import { PluginHost } from "../../core/src/plugins/host.js";
it("uses catalog profiles without issuing empty provider metadata requests", async () => {
  let calls = 0;
  const plugin = new OpenAIPlugin({
    apiKey: "fixture",
    fetch: async () => {
      calls++;
      return Response.json({
        id: "x",
        object: "model",
        created: 1,
        owned_by: "fixture",
      });
    },
  });
  expect(plugin).toBeInstanceOf(OpenAIPlugin);
  const host = new PluginHost();
  await host.attach(plugin);
  const provider: any = host
    .registrations()
    .find((r) => r.kind === "provider")!.value;
  expect(provider.id).toBe("openai");
  const model = provider.create("x");
  expect((await model.refreshProfile()).modelId).toBe("x");
  expect(calls).toBe(0);
  expect(
    provider.catalogModelRef({ providerId: "openai", modelId: "x" }),
  ).toEqual({ providerId: "openai", modelId: "x" });
  await host.dispose();
  const custom = new PluginHost();
  await custom.attach(
    new OpenAIPlugin({
      apiKey: "fixture",
      baseURL: "https://custom.invalid/v1",
    }),
  );
  const other: any = custom
    .registrations()
    .find((r) => r.kind === "provider")!.value;
  expect(
    other.catalogModelRef({ providerId: "openai", modelId: "x" }),
  ).toBeNull();
  await custom.dispose();
});
