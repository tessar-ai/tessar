import { it, expect } from "vitest";
import {
  Agent,
  type ModelAdapter,
  type ModelChunk,
  type ModelRequest,
} from "@tessar/core";
import { OpenAIProvider, OpenAIEmbedding, type OpenAIProviderOptions, type OpenAIEmbeddingOptions } from "../src/index.js";
import type { EmbeddingModel, Content, Chunk } from "@tessar/rag";

if (false) {
  const configuration: OpenAIEmbeddingOptions = {
    apiKey: "test", model: "fixture", dimensions: 1024, encoding_format: "base64",
    baseURL: "https://embedding.test/v1", defaultHeaders: { "x-custom": "value" },
    timeout: 30000, maxRetries: 2,
  };
  const model: EmbeddingModel = new OpenAIEmbedding(configuration);
  const documents: Promise<number[][]> = model.embedDocuments(["one", "two"] as const);
  const query: Promise<number[]> = model.embedQuery("query");
  const contents: Content[] = [{ text: "page content", format: "text", metadata: {} }];
  const chunks: Chunk[] = [{ ...contents[0]!, position: { contentIndex: 0, start: 0, end: 12 } }];
  const native = new OpenAIEmbedding(configuration);
  native.embedDocuments(contents);
  native.embedDocuments(chunks);
  native.embedDocuments(["raw", ...contents, ...chunks]);
  // @ts-expect-error document objects require string text
  native.embedDocuments([{ text: 1 }]);
  // @ts-expect-error the model is required
  new OpenAIEmbedding({ apiKey: "test" });
  // @ts-expect-error input belongs to the methods
  new OpenAIEmbedding({ model: "fixture", input: "text" });
  // @ts-expect-error chat request options are not embedding options
  new OpenAIEmbedding({ model: "fixture", temperature: 0.3 });
  // @ts-expect-error OpenAI embeddings have no input_type
  new OpenAIEmbedding({ model: "fixture", input_type: "search_query" });
  // @ts-expect-error encoding_format follows the native SDK union
  new OpenAIEmbedding({ model: "fixture", encoding_format: "invalid" });
  void documents;
  void query;
}

class OtherModel implements ModelAdapter {
  readonly ref = { providerId: "other", modelId: "test" };
  readonly options: { max_tokens?: number; temperature?: number } = {};
  validate(_request: ModelRequest) {}
  async *stream(): AsyncIterable<ModelChunk> {}
}

it("infers native model options for defaults, model-ID overrides and other adapters", () => {
  const model = new OpenAIProvider({ apiKey: "test", model: "fixture" });
  const agent = new Agent({ id: "test", model });
  expect(agent.getModel()).toBe(model);
  if (false) {
    const configuration: OpenAIProviderOptions = {
      api: "chat-completions",
      apiKey: "test",
      model: "fixture",
      reasoning_effort: "high",
    };
    new OpenAIProvider(configuration);
    const chat = new OpenAIProvider({
      api: "chat-completions",
      apiKey: "test",
      model: "fixture",
      reasoning_effort: "high",
      max_tokens: 100,
    });
    const chatAgent = new Agent({ id: "chat", model: chat });
    chatAgent.stream("hi", {
      modelOptions: { reasoning_effort: "low", max_completion_tokens: 100 },
    });
    agent.generate("hi", { model: chat, modelOptions: { max_tokens: 100 } });
    // @ts-expect-error Chat request fields are not Responses fields
    chatAgent.stream("hi", { modelOptions: { max_output_tokens: 100 } });
    new OpenAIProvider({
      api: "chat-completions",
      apiKey: "test",
      model: "fixture",
      // @ts-expect-error Responses reasoning is not Chat reasoning_effort
      reasoning: { effort: "high" },
    });
    // @ts-expect-error API belongs to the connection, not execution request overrides
    chatAgent.stream("hi", { modelOptions: { api: "responses" } });
    new OpenAIProvider({
      api: "chat-completions",
      apiKey: "test",
      model: "fixture",
      // @ts-expect-error Only one choice can be consumed by an Agent loop
      n: 2,
    });
    agent.stream("hi", {
      modelOptions: {
        reasoning: { effort: "low" },
        text: { verbosity: "low" },
      },
    });
    agent.generate("hi", {
      model: "another",
      modelOptions: { max_output_tokens: 100 },
    });
    // @ts-expect-error SDK reasoning effort has a specific union
    agent.stream("hi", { modelOptions: { reasoning: { effort: "invalid" } } });
    // @ts-expect-error Connection fields do not belong to request options
    agent.stream("hi", { modelOptions: { baseURL: "https://other.test" } });
    // @ts-expect-error Runtime-owned input is not a model option
    agent.stream("hi", { modelOptions: { input: "bypass" } });
    agent.generate("hi", {
      model: new OtherModel(),
      modelOptions: { max_tokens: 100 },
    });
    agent.stream("hi", {
      model: new OtherModel(),
      // @ts-expect-error Model override determines the option type, not the Agent default
      modelOptions: { max_output_tokens: 100 },
    });
    // @ts-expect-error model is required by the Agent constructor
    new Agent({ id: "missing" });
    // @ts-expect-error Provider input is derived by Agent
    new OpenAIProvider({ apiKey: "test", model: "fixture", input: "bypass" });
    new OpenAIProvider({
      apiKey: "test",
      model: "fixture",
      // @ts-expect-error Provider-managed compaction requires a supported continuity codec
      context_management: [{ type: "compaction" }],
    });
  }
});
