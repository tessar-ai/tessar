import { fail, requireId } from "../errors.js";
import { assertJson, immutable } from "../helpers/json.js";
import { freezeSnapshot, jsonSnapshots } from "../helpers/json-snapshot.js";
import {
  AssistantMessage,
  HumanMessage,
  type Message,
  SystemMessage,
  ToolMessage,
  type MessageData,
  validateContent,
} from "./message.js";

const INVALID_MESSAGE = "InvalidMessage";
const SCHEMA_INCOMPATIBLE = "SchemaIncompatible";
const ROLE = { USER: "user", SYSTEM: "system", ASSISTANT: "assistant", TOOL: "tool" } as const;
export function inputMessages(
  input: MessageData | readonly MessageData[],
): readonly MessageData[] {
  const values = Array.isArray(input) ? input : [input];
  return values.map((value) =>
    freezeSnapshot(messageData(MessageCodec.decode(MessageCodec.encode(value))), true),
  );
}
function messageData(message: Message): MessageData {
  if (message.role === ROLE.TOOL) requireId(message.toolCallId!, "toolCallId");
  const {
    schemaVersion,
    id,
    role,
    content,
    metadata,
    providerState,
    toolCallId,
  } = message;
  return {
    schemaVersion,
    id,
    role,
    content,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(providerState !== undefined ? { providerState } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  };
}
function readMessageData(data: unknown): MessageData {
  assertJson(data);
  if (!data || typeof data !== "object" || Array.isArray(data))
    fail(INVALID_MESSAGE, "Expected message object");
  const value = data as unknown as MessageData;
  if (value.schemaVersion !== 1)
    fail(SCHEMA_INCOMPATIBLE, "Unsupported message schema");
  requireId(value.id, "message id");
  return value;
}
/** @internal Untrusted graphs keep constructor normalization and clone errors. */
export function validateMessage(data: unknown): MessageData {
  if (!data || typeof data !== "object" || !jsonSnapshots.has(data))
    return MessageCodec.decode(data);
  const value = readMessageData(data);
  if (value.role === ROLE.TOOL) requireId(value.toolCallId!, "toolCallId");
  else if (value.role !== ROLE.USER && value.role !== ROLE.SYSTEM && value.role !== ROLE.ASSISTANT)
    fail(INVALID_MESSAGE, "Unknown message role");
  return { ...value, content: validateContent(value.content) };
}
export const MessageCodec = {
  encode(message: Message): MessageData {
    return immutable(messageData(message));
  },
  decode(data: unknown): Message {
    const value = readMessageData(data);
    const options = {
      id: value.id,
      metadata: value.metadata,
      providerState: value.providerState,
    };
    switch (value.role) {
      case ROLE.USER:
        return new HumanMessage(value.content, options);
      case ROLE.SYSTEM:
        return new SystemMessage(value.content, options);
      case ROLE.ASSISTANT:
        return new AssistantMessage(value.content, options);
      case ROLE.TOOL:
        requireId(value.toolCallId!, "toolCallId");
        return new ToolMessage(value.content, {
          ...options,
          toolCallId: value.toolCallId,
        });
      default:
        return fail(INVALID_MESSAGE, "Unknown message role");
    }
  },
};
