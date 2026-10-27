import { assertJson, immutable, systemClock } from "../json.js";
import { fail } from "../errors.js";
import type { ModelChunk, ModelPartChunk } from "./contract.js";

type OpenPart = {
  start: Extract<
    ModelPartChunk,
    { type: "text.start" | "reasoning.start" | "tool.call.start" }
  >;
  kind: string;
  text: string;
  ended: boolean;
};
/** One validator for every adapter, primary call and auxiliary iterator. */
export class PartLifecycle {
  private readonly parts = new Map<string, OpenPart>();
  private messageId?: string;
  private responded = false;
  constructor(private readonly now = systemClock.now) {}
  accept(chunk: ModelChunk): void {
    const invalid = (): never =>
      fail(
        "InvalidModelStream",
        "Invalid model part identity, order or content",
      );
    if (this.responded) invalid();
    if (chunk.type === "usage") return;
    const id =
      chunk.type === "response" ? chunk.response.message.id : chunk.messageId;
    if (
      typeof id !== "string" ||
      !id ||
      (this.messageId && this.messageId !== id)
    )
      invalid();
    this.messageId = id;
    if (chunk.type === "response") {
      if ([...this.parts.values()].some((part) => !part.ended)) invalid();
      this.responded = true;
      return;
    }
    const kind = chunk.type.slice(0, chunk.type.lastIndexOf("."));
    const saved = this.parts.get(chunk.partId);
    if (
      typeof chunk.partId !== "string" ||
      !chunk.partId ||
      !Number.isInteger(chunk.partIndex) ||
      chunk.partIndex < 0
    )
      invalid();
    if (chunk.type.endsWith(".start")) {
      if (saved || chunk.partIndex !== this.parts.size) invalid();
      if (
        !["text.start", "reasoning.start", "tool.call.start"].includes(
          chunk.type,
        )
      )
        invalid();
      const start = immutable(chunk) as OpenPart["start"];
      if (
        !["observed", "provider"].includes(start.boundary) ||
        !Number.isFinite(Date.parse(start.startedAt))
      )
        invalid();
      if (
        start.type === "tool.call.start" &&
        ("arguments" in start ||
          (start.name !== undefined &&
            (typeof start.name !== "string" || !start.name)) ||
          (start.toolCallId !== undefined &&
            (typeof start.toolCallId !== "string" || !start.toolCallId)))
      )
        invalid();
      this.parts.set(chunk.partId, { start, kind, text: "", ended: false });
      return;
    }
    if (
      !saved ||
      saved.ended ||
      saved.kind !== kind ||
      saved.start.partIndex !== chunk.partIndex
    )
      invalid();
    const part = saved!;
    if (chunk.type === "text.delta" || chunk.type === "reasoning.delta") {
      if (typeof chunk.delta !== "string") invalid();
      part.text += chunk.delta;
    } else if (
      chunk.type === "text.end" ||
      chunk.type === "reasoning.end" ||
      chunk.type === "tool.call.end"
    ) {
      if (
        chunk.startedAt !== part.start.startedAt ||
        !Number.isFinite(Date.parse(chunk.endedAt)) ||
        !["completed", "interrupted"].includes(chunk.status) ||
        !["observed", "provider"].includes(chunk.boundary)
      )
        invalid();
      if (chunk.type === "tool.call.end") {
        const start = part.start as Extract<
          ModelPartChunk,
          { type: "tool.call.start" }
        >;
        if (
          (start.name !== undefined && start.name !== chunk.name) ||
          (start.toolCallId !== undefined &&
            start.toolCallId !== chunk.toolCallId)
        )
          invalid();
        if (chunk.status === "completed") {
          if (
            typeof chunk.name !== "string" ||
            !chunk.name ||
            typeof chunk.toolCallId !== "string" ||
            !chunk.toolCallId ||
            !chunk.arguments ||
            typeof chunk.arguments !== "object" ||
            Array.isArray(chunk.arguments)
          )
            invalid();
          assertJson(chunk.arguments);
        } else if ("arguments" in chunk) invalid();
      } else if (typeof chunk.text !== "string") invalid();
      part.ended = true;
    } else invalid();
  }
  interrupted(): ModelPartChunk[] {
    const ends: ModelPartChunk[] = [];
    for (const part of this.parts.values())
      if (!part.ended) {
        const { type, ...start } = part.start;
        const common = {
          ...start,
          status: "interrupted" as const,
          endedAt: this.now(),
          boundary: "observed" as const,
        };
        ends.push(
          immutable(
            type === "tool.call.start"
              ? { ...common, type: "tool.call.end" }
              : {
                  ...common,
                  type: type === "text.start" ? "text.end" : "reasoning.end",
                  text: part.text,
                },
          ) as ModelPartChunk,
        );
        part.ended = true;
      }
    return ends;
  }
}
