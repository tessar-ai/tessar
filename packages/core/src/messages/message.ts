import { fail, requireId } from "../errors.js";
import {
  assertJson,
  immutable,
  randomIds,
  type JsonObject,
  type JsonValue,
} from "../json.js";
import type { ContentPart } from "./parts.js";

const INVALID_MESSAGE = "InvalidMessage";
export type MessageRole = "system" | "user" | "assistant" | "tool";
export interface MessageOptions {
  id?: string;
  metadata?: JsonObject;
  providerState?: JsonValue;
}
export interface MessageData {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly role: MessageRole;
  readonly content: readonly ContentPart[];
  readonly metadata?: JsonObject;
  readonly providerState?: JsonValue;
  readonly toolCallId?: string;
}
export function normalizeContent(
  content: string | readonly ContentPart[],
): readonly ContentPart[] {
  const parts =
    typeof content === "string"
      ? [{ type: "text" as const, text: content }]
      : content;
  assertJson(parts);
  if (!Array.isArray(parts))
    fail(INVALID_MESSAGE, "Message content must be text or parts");
  for (const part of parts) {
    if (!part || typeof part !== "object")
      fail(INVALID_MESSAGE, "Invalid message part");
    if (
      part.metadata !== undefined &&
      (!part.metadata ||
        typeof part.metadata !== "object" ||
        Array.isArray(part.metadata))
    )
      fail(INVALID_MESSAGE, "Part metadata must be a JSON object");
    switch (part.type) {
      case "text":
      case "reasoning":
        if (typeof part.text !== "string")
          fail(INVALID_MESSAGE, "Text is required");
        break;
      case "tool-call":
        requireId(part.toolCallId, "toolCallId");
        requireId(part.name, "tool name");
        if (
          !part.arguments ||
          typeof part.arguments !== "object" ||
          Array.isArray(part.arguments)
        )
          fail(INVALID_MESSAGE, "Arguments must be an object");
        break;
      case "image":
      case "audio":
      case "file":
        requireId(part.mediaType, "mediaType");
        if (typeof part.data !== "string")
          fail(INVALID_MESSAGE, "Media data required");
        break;
      case "data":
        if (!Object.hasOwn(part, "data"))
          fail(INVALID_MESSAGE, "Data is required");
        break;
      default:
        fail(INVALID_MESSAGE, "Unknown content part");
    }
  }
  return immutable(parts);
}
export abstract class Message implements MessageData {
  readonly schemaVersion = 1 as const;
  readonly id: string;
  readonly content: readonly ContentPart[];
  readonly metadata?: JsonObject;
  readonly providerState?: JsonValue;
  readonly toolCallId?: string;
  protected constructor(
    readonly role: MessageRole,
    content: string | readonly ContentPart[],
    options: MessageOptions = {},
    toolCallId?: string,
  ) {
    this.id = requireId(options.id ?? randomIds.next("message"));
    this.content = normalizeContent(content);
    if (options.metadata !== undefined)
      this.metadata = immutable(options.metadata);
    if (options.providerState !== undefined)
      this.providerState = immutable(options.providerState);
    if (toolCallId !== undefined)
      this.toolCallId = requireId(toolCallId, "toolCallId");
    Object.freeze(this);
  }
}
export class HumanMessage extends Message {
  constructor(
    content: string | readonly ContentPart[],
    options?: MessageOptions,
  ) {
    super("user", content, options);
  }
}
export class SystemMessage extends Message {
  constructor(
    content: string | readonly ContentPart[],
    options?: MessageOptions,
  ) {
    super("system", content, options);
  }
}
export class AssistantMessage extends Message {
  constructor(
    content: string | readonly ContentPart[],
    options?: MessageOptions,
  ) {
    super("assistant", content, options);
  }
}
export class ToolMessage extends Message {
  constructor(
    content: string | readonly ContentPart[],
    options?: MessageOptions & { toolCallId?: string },
  ) {
    super("tool", content, options, options?.toolCallId);
  }
}
