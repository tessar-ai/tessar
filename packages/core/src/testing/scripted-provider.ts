import type {
  ModelAdapter,
  ModelCallContext,
  ModelChunk,
  ModelRef,
  ModelRequest,
  ModelResponse,
} from "../models/contract.js";
import { AssistantMessage } from "../messages/message.js";
import { MessageCodec } from "../messages/codec.js";
import { immutable } from "../json.js";
import { normalizeUsage, type TokenCounts } from "../trace/usage.js";
import { TessarError } from "../errors.js";
export interface ModelScript {
  text?: string;
  response?: ModelResponse;
  usage?: Partial<TokenCounts>;
  chunks?: readonly ModelChunk[];
  error?: Error;
  gate?: Promise<void>;
}
export class ScriptedProvider implements ModelAdapter {
  readonly ref: ModelRef = { providerId: "scripted", modelId: "test" };
  readonly calls: ModelRequest[] = [];
  constructor(private readonly scripts: readonly ModelScript[]) {}
  withModel(modelId: string): ModelAdapter {
    return {
      ref: { ...this.ref, modelId },
      validate: this.validate.bind(this),
      stream: this.stream.bind(this),
    };
  }
  validate(request: ModelRequest): void {
    if (request.model.providerId !== this.ref.providerId)
      throw new TessarError("ModelContextIncompatible", "Wrong provider");
  }
  async *stream(
    request: ModelRequest,
    context: ModelCallContext,
  ): AsyncIterable<ModelChunk> {
    this.validate(request);
    const index = this.calls.length;
    this.calls.push(immutable(request));
    const script = this.scripts[index];
    if (!script) throw new TessarError("ProviderError", "No scripted response");
    if (script.gate)
      await Promise.race([
        script.gate,
        new Promise<never>((_, reject) => {
          if (context.signal.aborted)
            reject(new TessarError("Cancelled", "Cancelled"));
          else
            context.signal.addEventListener(
              "abort",
              () => reject(new TessarError("Cancelled", "Cancelled")),
              { once: true },
            );
        }),
      ]);
    if (context.signal.aborted) throw new TessarError("Cancelled", "Cancelled");
    if (script.chunks) for (const chunk of script.chunks) yield chunk;
    if (script.error) throw script.error;
    const usage = normalizeUsage(script.usage ?? {});
    const response = script.response ?? {
      message: MessageCodec.encode(new AssistantMessage(script.text ?? "")),
      usage,
      finishReason: "stop",
    };
    if (!script.chunks)
      for (const [partIndex, part] of response.message.content.entries()) {
        if (
          part.type !== "text" &&
          part.type !== "reasoning" &&
          part.type !== "tool-call"
        )
          continue;
        const kind = part.type === "tool-call" ? "tool.call" : part.type;
        const identity = {
          messageId: response.message.id,
          partId: "part-" + partIndex,
          partIndex,
        };
        const startedAt = context.now?.() ?? new Date().toISOString();
        yield {
          type: `${kind}.start`,
          ...identity,
          startedAt,
          boundary: "observed",
        } as ModelChunk;
        if (script.text && part.type === "text")
          yield { type: "text.delta", ...identity, delta: part.text };
        yield {
          type: `${kind}.end`,
          ...identity,
          startedAt,
          endedAt: context.now?.() ?? new Date().toISOString(),
          boundary: "observed",
          status: "completed",
          ...(part.type === "tool-call"
            ? {
                toolCallId: part.toolCallId,
                name: part.name,
                arguments: part.arguments,
              }
            : { text: part.text }),
        } as ModelChunk;
      }
    yield { type: "usage", usage: response.usage ?? usage };
    yield { type: "response", response };
  }
}
