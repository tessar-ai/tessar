import type {
  ModelCallContext,
  ModelPartChunk,
  JsonObject,
} from "@tessar/core";
import { responseError } from "./response-error.js";
import type { ModelRef } from "@tessar/core";

type Kind = "text" | "reasoning" | "tool.call";
/** Buffers protocol fragments; tool arguments are published only when complete. */
export class Parts {
  messageId = crypto.randomUUID() as string;
  private readonly parts = new Map<
    string,
    {
      kind: Kind;
      index: number;
      startedAt: string;
      text: string;
      ended: boolean;
    }
  >();
  private readonly now: () => string;
  constructor(
    private readonly ref: ModelRef,
    context: ModelCallContext,
  ) {
    this.now = context.now ?? (() => new Date().toISOString());
  }
  identify(id: string): void {
    if (!this.parts.size && id) this.messageId = id;
  }
  start(
    kind: Kind,
    partId: string,
    boundary: "provider" | "observed" = "observed",
  ): ModelPartChunk[] {
    if (this.parts.has(partId)) return [];
    const part = {
      kind,
      index: this.parts.size,
      startedAt: this.now(),
      text: "",
      ended: false,
    };
    this.parts.set(partId, part);
    return [
      {
        type: `${kind}.start`,
        messageId: this.messageId,
        partId,
        partIndex: part.index,
        startedAt: part.startedAt,
        boundary,
      } as ModelPartChunk,
    ];
  }
  delta(
    kind: "text" | "reasoning",
    partId: string,
    delta: string,
  ): ModelPartChunk[] {
    const result = this.start(kind, partId);
    const part = this.parts.get(partId)!;
    if (part.ended || part.kind !== kind)
      throw responseError(
        this.ref,
        "Provider reopened a completed content part",
      );
    part.text += delta;
    result.push({
      type: `${kind}.delta`,
      messageId: this.messageId,
      partId,
      partIndex: part.index,
      delta,
    });
    return result;
  }
  end(
    kind: Kind,
    partId: string,
    value: string | { toolCallId: string; name: string; arguments: JsonObject },
    boundary: "provider" | "observed" = "provider",
  ): ModelPartChunk[] {
    const result = this.start(kind, partId, boundary);
    const part = this.parts.get(partId)!;
    if (part.ended) return result;
    if (part.kind !== kind)
      throw responseError(this.ref, "Provider changed content part type");
    part.ended = true;
    result.push({
      type: `${kind}.end`,
      messageId: this.messageId,
      partId,
      partIndex: part.index,
      startedAt: part.startedAt,
      endedAt: this.now(),
      status: "completed",
      boundary,
      ...(typeof value === "string" ? { text: value } : value),
    } as ModelPartChunk);
    return result;
  }
  closeText(): ModelPartChunk[] {
    return [...this.parts].flatMap(([id, part]) =>
      part.kind === "tool.call" || part.ended
        ? []
        : this.end(part.kind, id, part.text, "observed"),
    );
  }
}
