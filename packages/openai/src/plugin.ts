import type { Plugin, PluginContext } from "@tessar/core";
import {
  OpenAIProvider,
  type OpenAIAPI,
  type OpenAIProviderOptions,
} from "./provider.js";
export type OpenAIPluginOptions =
  | Omit<OpenAIProviderOptions<"responses">, "model">
  | Omit<OpenAIProviderOptions<"chat-completions">, "model">;
export class OpenAIPlugin implements Plugin {
  readonly id: string;
  private readonly providerId: string;
  private readonly options: OpenAIPluginOptions;

  constructor(options: OpenAIPluginOptions) {
    this.options = { ...options };
    this.providerId = options.providerId ?? "openai";
    this.id = "provider." + this.providerId;
  }

  setup(tessar: PluginContext): void {
    const options = this.options,
      id = this.providerId;
    let connection: OpenAIProvider<OpenAIAPI> | undefined;
    const create = (model: string): OpenAIProvider<OpenAIAPI> => {
      connection ??= new OpenAIProvider<OpenAIAPI>({ ...options, model });
      return connection.ref.modelId === model
        ? connection
        : connection.withModel(model);
    };
    tessar.models.register({
      id,
      endpoint: options.baseURL ?? "https://api.openai.com/v1",
      metadataPartition: options.metadataPartition,
      metadata: {
        resolve: (ref, context) =>
          create(ref.modelId)
            .providerRegistration()
            .metadata!.resolve(ref, context),
      },
      catalogModelRef: (ref) =>
        !options.baseURL ||
        options.baseURL.replace(/\/$/, "") === "https://api.openai.com/v1"
          ? { providerId: "openai", modelId: ref.modelId }
          : null,
      catalogMappingVersion: 1,
      create,
    });
  }
}
