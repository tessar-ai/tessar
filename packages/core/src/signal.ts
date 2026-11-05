import { fail, requireId } from "./errors.js";
import {
  HumanMessage,
  normalizeContent,
  type MessageData,
} from "./messages/message.js";
import { MessageCodec } from "./messages/codec.js";
import type { ContentPart } from "./messages/parts.js";
import type { JsonObject } from "./json.js";

const INVALID_CONFIGURATION = "InvalidConfiguration";

export type SignalTarget =
  | { streamId: string; threadId?: never }
  | { threadId: string; streamId?: never };

export type SendSignalOptions = SignalTarget & {
  content: string | readonly ContentPart[];
  persist?: boolean;
  tagName?: string;
  attributes?: Record<string, string | number | boolean>;
  metadata?: JsonObject;
};

/** @internal XML names use the unqualified ASCII subset, without namespaces. */
export function createSignalMessage(options: SendSignalOptions): MessageData {
  if (!options || typeof options !== "object")
    fail(INVALID_CONFIGURATION, "Signal options are required");
  if ((options.streamId !== undefined) === (options.threadId !== undefined))
    fail(INVALID_CONFIGURATION, "Provide exactly one signal target");
  requireId(options.streamId ?? options.threadId!, "signal target");
  if ("role" in options)
    fail(INVALID_CONFIGURATION, "Signals always have user role");
  if (options.persist !== undefined && typeof options.persist !== "boolean")
    fail(INVALID_CONFIGURATION, "Signal persist must be boolean");
  if (
    options.metadata !== undefined &&
    (!options.metadata ||
      typeof options.metadata !== "object" ||
      Array.isArray(options.metadata))
  )
    fail("InvalidMessage", "Signal metadata must be a JSON object");
  let content = normalizeContent(options.content);
  const validName = (name: string) =>
    typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name);
  if (options.tagName === undefined && options.attributes !== undefined)
    fail(INVALID_CONFIGURATION, "Signal attributes require tagName");
  if (options.tagName !== undefined) {
    if (!validName(options.tagName))
      fail(INVALID_CONFIGURATION, "Invalid signal XML tagName");
    if (
      options.attributes !== undefined &&
      (!options.attributes ||
        typeof options.attributes !== "object" ||
        Array.isArray(options.attributes))
    )
      fail(INVALID_CONFIGURATION, "Signal attributes must be an object");
    const attributes = Object.entries(options.attributes ?? {})
      .map(([name, value]) => {
        if (
          !validName(name) ||
          !["string", "number", "boolean"].includes(typeof value) ||
          (typeof value === "number" && !Number.isFinite(value))
        )
          fail(INVALID_CONFIGURATION, "Invalid signal XML attribute");
        const escaped = String(value)
          .replaceAll("&", "&amp;")
          .replaceAll('"', "&quot;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll("\r", "&#13;")
          .replaceAll("\n", "&#10;")
          .replaceAll("\t", "&#9;");
        return ` ${name}="${escaped}"`;
      })
      .join("");
    content = [
      { type: "text", text: `<${options.tagName}${attributes}>\n` },
      ...content,
      { type: "text", text: `\n</${options.tagName}>` },
    ];
  }
  return MessageCodec.encode(
    new HumanMessage(content, { metadata: options.metadata }),
  );
}
