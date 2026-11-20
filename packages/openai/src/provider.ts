import type OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions/completions";
import {
  ProfileResolver,
  snapshotModelOptions,
  requireId,
  fail,
  type ModelProfile,
  type ModelProviderRegistration,
  type ModelRequest,
  type ModelCallContext,
  type ModelChunk,
  type JsonObject,
} from "@tessar/core";
import {
  OpenAIAdapter,
  createClient,
  clientKeys,
  OPENAI_API,
  OPENAI_ENDPOINT,
  type OpenAIOptions,
} from "./adapter.js";
import { OpenAIChatAdapter } from "./chat-adapter.js";

const UNSUPPORTED_OPTION = "UnsupportedOption";

export type OpenAIModelOptions = Omit<
  ResponseCreateParamsStreaming,
  | "model"
  | "input"
  | "instructions"
  | "tools"
  | "stream"
  | "background"
  | "conversation"
  | "previous_response_id"
  | "context_management"
>;
export type OpenAIAPI = "responses" | "chat-completions";
export type OpenAIChatModelOptions = Omit<
  ChatCompletionCreateParamsStreaming,
  | "model"
  | "messages"
  | "tools"
  | "stream"
  | "functions"
  | "function_call"
  | "n"
> & { n?: 1 };
type OptionsFor<A extends OpenAIAPI> = A extends "chat-completions"
  ? OpenAIChatModelOptions
  : OpenAIModelOptions;
export type OpenAIChatOptions<A extends OpenAIAPI = OpenAIAPI> =
  OpenAIOptions & {
    model: string;
    connectionId?: string;
  } & (A extends "chat-completions"
    ? { api: "chat-completions" } & OpenAIChatModelOptions
    : { api?: "responses" } & OpenAIModelOptions);

interface Connection {
  client: OpenAI;
  identity: string;
  resolver: ProfileResolver;
}

export class OpenAIChat<
  A extends OpenAIAPI = "responses",
> extends OpenAIAdapter {
  readonly options: Readonly<OptionsFor<A>>;
  readonly api: A;
  private readonly chat?: OpenAIChatAdapter;
  private readonly clientOptions: OpenAIOptions;
  private readonly sharedConnection: Connection;
  private readonly registration: ModelProviderRegistration;

  constructor(configuration: OpenAIChatOptions<A> & { api?: A });
  /** @internal */
  constructor(
    configuration: OpenAIChatOptions<A> & { api?: A },
    connection: Connection,
  );
  constructor(
    configuration: OpenAIChatOptions<A> & { api?: A },
    connection?: Connection,
  ) {
    const {
      model,
      providerId = "openai",
      metadataPartition,
      connectionId,
      api = OPENAI_API.RESPONSES,
      ...fields
    } = configuration;
    if (api !== OPENAI_API.RESPONSES && api !== OPENAI_API.CHAT_COMPLETIONS)
      fail("InvalidConfiguration", "Choose responses or chat-completions");
    requireId(model, "model id");
    requireId(providerId, "provider id");
    const clientOptions = Object.fromEntries(
      clientKeys
        .filter((key) => fields[key] !== undefined)
        .map((key) => [key, fields[key]]),
    ) as OpenAIOptions;
    const body = Object.fromEntries(
      Object.entries(fields).filter(
        ([key, value]) =>
          !clientKeys.includes(key as any) && value !== undefined,
      ),
    );
    for (const key of [
      "input",
      "messages",
      "instructions",
      "tools",
      "stream",
      "functions",
      "function_call",
    ])
      if (key in body)
        fail(UNSUPPORTED_OPTION, key + " is owned by the Agent runtime");
    if (
      body.background === true ||
      body.conversation != null ||
      body.previous_response_id != null ||
      body.context_management != null
    )
      fail(
        UNSUPPORTED_OPTION,
        "Background, provider-managed conversations and compaction are not supported by the Agent loop",
      );
    if (api === OPENAI_API.CHAT_COMPLETIONS && body.n != null && body.n !== 1)
      fail(UNSUPPORTED_OPTION, "An Agent consumes one Chat completion choice");
    const requestOptions = snapshotModelOptions(body);
    const selected = connection ?? {
      client: createClient(clientOptions),
      identity:
        connectionId === undefined
          ? crypto.randomUUID()
          : requireId(connectionId, "connection id"),
      resolver: new ProfileResolver(),
    };
    const descriptor = Object.freeze({
      providerId,
      connectionId: selected.identity,
      protocol: api,
      endpoint: selected.client.baseURL.replace(/\/$/, ""),
    });
    super(
      clientOptions,
      Object.freeze({
        providerId,
        modelId: model,
        connectionId: selected.identity,
      }),
      selected.client,
      descriptor,
    );
    this.options = requestOptions as Readonly<OptionsFor<A>>;
    this.api = api as A;
    if (api === OPENAI_API.CHAT_COMPLETIONS)
      this.chat = new OpenAIChatAdapter(
        clientOptions,
        this.ref,
        selected.client,
        descriptor,
      );
    this.clientOptions = { ...clientOptions, providerId, metadataPartition };
    this.sharedConnection = selected;
    const officialEndpoint =
      !clientOptions.baseURL ||
      clientOptions.baseURL.replace(/\/$/, "") === OPENAI_ENDPOINT;
    this.registration = {
      id: providerId,
      create: (modelId) => this.withModel(modelId),
      endpoint: clientOptions.baseURL ?? OPENAI_ENDPOINT,
      metadataPartition: metadataPartition ?? selected.identity,
      catalogModelRef: (ref) =>
        officialEndpoint
          ? { providerId: "openai", modelId: ref.modelId }
          : null,
      catalogMappingVersion: 1,
    };
  }

  withModel(modelId: string): OpenAIChat<A> {
    return new OpenAIChat<A>(
      {
        ...this.clientOptions,
        ...this.options,
        api: this.api,
        model: modelId,
      } as OpenAIChatOptions<A> & { api?: A },
      this.sharedConnection,
    );
  }

  effortOptions(level: string, options: JsonObject): JsonObject {
    const levels = [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ] as const satisfies readonly Exclude<
      import("openai/resources/shared").ReasoningEffort,
      null
    >[];
    if (!(levels as readonly string[]).includes(level))
      fail(UNSUPPORTED_OPTION, "Unsupported OpenAI effort level: " + level);
    if (this.api === OPENAI_API.CHAT_COMPLETIONS)
      return { ...options, reasoning_effort: level };
    const reasoning = options.reasoning;
    return {
      ...options,
      reasoning: {
        ...(reasoning &&
          typeof reasoning === "object" &&
          !Array.isArray(reasoning)
          ? reasoning
          : {}),
        effort: level,
      },
    };
  }

  /** @internal Shared provider registration used by the built-in plugin. */
  providerRegistration(): ModelProviderRegistration {
    return this.registration;
  }

  override validate(request: ModelRequest): void {
    if (this.chat) this.chat.validate(request);
    else super.validate(request);
  }

  override async *stream(
    request: ModelRequest,
    context: ModelCallContext,
  ): AsyncIterable<ModelChunk> {
    if (this.chat) yield* this.chat.stream(request, context);
    else yield* super.stream(request, context);
  }
  profile(): Readonly<ModelProfile> {
    return this.sharedConnection.resolver.current(this.ref, this.registration);
  }
  refreshProfile(
    options: { signal?: AbortSignal } = {},
  ): Promise<ModelProfile> {
    return this.sharedConnection.resolver.resolve(
      this.ref,
      this.registration,
      options.signal,
    );
  }
}
