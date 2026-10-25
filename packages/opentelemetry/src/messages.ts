import type { MessageData, ModelRequest } from "@tessar/core";

type TraceMessage = Pick<MessageData, "role" | "content" | "toolCallId">;

/** Display projection only: the provider request and its history remain unchanged. */
export function inputMessages(
  request: Pick<ModelRequest, "instructions" | "messages">,
): readonly TraceMessage[] {
  const sections = request.instructions.sections;
  if (!sections.some((section) => section.content.length > 0))
    return request.messages;
  return [
    {
      role: "system",
      content: [
        {
          type: "text",
          text: sections.map((section) => section.content).join("\n\n"),
        },
      ],
    },
    ...request.messages,
  ];
}

/** GenAI message parts keep visible reasoning separate from the final answer. */
export function genAIMessages(values: readonly TraceMessage[]) {
  return values.map((message) => ({
    role: message.role,
    parts:
      message.role === "tool"
        ? [
            {
              type: "tool_call_response",
              ...(message.toolCallId ? { id: message.toolCallId } : {}),
              response:
                message.content.length === 1
                  ? toolContent(message.content[0]!)
                  : message.content.map(toolContent),
            },
          ]
        : message.content.map((part) => {
            if (part.type === "text" || part.type === "reasoning")
              return { type: part.type, content: part.text };
            if (part.type === "tool-call")
              return {
                type: "tool_call",
                id: part.toolCallId,
                name: part.name,
                arguments: part.arguments,
              };
            // Media/custom parts retain their declared type and data as generic parts.
            return part;
          }),
  }));
}

function toolContent(part: MessageData["content"][number]) {
  return part.type === "text"
    ? part.text
    : part.type === "data"
      ? part.data
      : part;
}
