import { expect, it } from "vitest";
import * as sdk from "../src/index.js";
import type {
  OpenAIAPI,
  OpenAIChatOptions,
  OpenAIOptions,
} from "../src/index.js";
// @ts-expect-error The low-level adapter is an implementation detail.
import type { OpenAIAdapter } from "../src/index.js";

it("exports the provider, embedding model and plugin with useful configuration types", () => {
  expect(Object.keys(sdk).sort()).toEqual(["OpenAIChat", "OpenAIEmbedding", "OpenAIPlugin", "OpenAIReranker"]);
  const api: OpenAIAPI = "chat-completions";
  const connection: OpenAIOptions = { apiKey: "example" };
  const options: OpenAIChatOptions<typeof api> = {
    ...connection,
    api,
    model: "test",
  };
  const model = new sdk.OpenAIChat(options);
  expect(model.api).toBe(api);
});
