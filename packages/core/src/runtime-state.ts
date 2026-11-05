import { stream as streamEvents, input as inputEvents, model as modelEvents, text as textEvents, reasoning as reasoningEvents, tool as toolEvents, message as messageEvents } from "./events/type.js";
import type { ErrorInfo } from "./errors.js";
import { immutable, type JsonValue } from "./json.js";
import type { ContentPart } from "./messages/parts.js";
import type { MessageData } from "./messages/message.js";
export type RuntimePart = {
  readonly partId: string;
  readonly partIndex: number;
  readonly status: "streaming" | "completed" | "interrupted";
} & (
    | {
      [K in "text" | "reasoning"]: { readonly type: K; readonly text: string };
    }["text" | "reasoning"]
    | {
      readonly type: "tool-call";
      readonly toolCallId?: string;
      readonly name?: string;
      readonly arguments?: import("./json.js").JsonObject;
    }
  );
export type RuntimeDraft = Omit<MessageData, "content"> & {
  readonly content: readonly RuntimePart[];
};
export type RuntimeMessage = Omit<MessageData, "content"> & {
  readonly content: readonly (ContentPart | RuntimePart)[];
};
import type { InterruptRecord } from "./state/schema.js";
import type { StreamStatus, ToolExecutionRecord } from "./trace/records.js";
import type { StreamEvent } from "./events/definition.js";

export interface StateTool {
  readonly id: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly status: string;
  readonly progress: JsonValue | null;
  readonly result: MessageData | null;
  readonly error: ErrorInfo | null;
}

/** An immutable rendering snapshot, separate from durable checkpoint state. */
export interface RuntimeState {
  readonly status: StreamStatus | "idle" | "closed";
  /** Committed messages and the current draft, in conversation order. */
  readonly messages: readonly RuntimeMessage[];
  readonly currentMessage: RuntimeDraft | null;
  readonly tools: readonly StateTool[];
  readonly interrupt: InterruptRecord | null;
  readonly queuedInputs: number;
  readonly error: ErrorInfo | null;
}

/** @internal Restore renderable tool fields from committed records. */
export function stateTool(record: ToolExecutionRecord): StateTool {
  return {
    id: record.id,
    toolCallId: record.toolCallId,
    name: record.toolName,
    status: record.status,
    progress: null,
    result: record.result,
    error: record.error,
  };
}

/** @internal Shared projection for standalone streams and Session snapshots. */
export class StateView {
  private value: RuntimeState = immutable({
    status: "idle",
    messages: [],
    currentMessage: null,
    tools: [],
    interrupt: null,
    queuedInputs: 0,
    error: null,
  });
  get(): RuntimeState {
    return this.value;
  }
  update(patch: Partial<RuntimeState>): RuntimeState {
    return (this.value = immutable({ ...this.value, ...patch }));
  }
  private upsert(
    message: MessageData | RuntimeMessage,
  ): readonly RuntimeMessage[] {
    return this.value.messages.some((value) => value.id === message.id)
      ? this.value.messages.map((value) =>
        value.id === message.id ? message : value,
      )
      : [...this.value.messages, message];
  }
  consume(event: StreamEvent): RuntimeState | null {
    switch (event.type) {
      case streamEvents.started:
      case streamEvents.resumed:
        return this.update({ status: "running", interrupt: null, error: null });
      case inputEvents.received: {
        let messages = this.value.messages;
        for (const message of event.payload.messages)
          if (!messages.some((value) => value.id === message.id))
            messages = [...messages, message];
        return this.update({ messages });
      }
      case modelEvents.start: {
        if (event.payload.purpose === "auxiliary") return null;
        const draft = this.value.currentMessage;
        return this.update({
          currentMessage: null,
          error: null,
          messages: this.value.messages.filter(
            (message) => message.id !== draft?.id,
          ),
        });
      }
      case textEvents.start:
      case reasoningEvents.start:
      case toolEvents.call.start:
      case textEvents.delta:
      case reasoningEvents.delta:
      case textEvents.end:
      case reasoningEvents.end:
      case toolEvents.call.end: {
        if (event.payload.purpose === "auxiliary") return null;
        const payload = event.payload;
        let draft = this.value.currentMessage;
        if (!draft || draft.id !== payload.messageId)
          draft = {
            schemaVersion: 1,
            id: payload.messageId,
            role: "assistant",
            content: [],
          };
        const content = [...draft.content];
        const index = content.findIndex(
          (part) => part.partId === payload.partId,
        );
        const previous = index < 0 ? undefined : content[index];
        const identity = {
          partId: payload.partId,
          partIndex: payload.partIndex,
        };
        let part: RuntimePart;
        if (event.type === toolEvents.call.start) {
          part = {
            ...identity,
            type: "tool-call",
            status: "streaming",
            ...(event.payload.toolCallId
              ? { toolCallId: event.payload.toolCallId }
              : {}),
            ...(event.payload.name ? { name: event.payload.name } : {}),
          };
        } else if (event.type === toolEvents.call.end) {
          const value = event.payload;
          part = {
            ...identity,
            type: "tool-call",
            status: value.status,
            ...(value.toolCallId ? { toolCallId: value.toolCallId } : {}),
            ...(value.name ? { name: value.name } : {}),
            ...(value.status === "completed"
              ? { arguments: value.arguments }
              : {}),
          };
        } else {
          const value =
            event.payload as import("./models/contract.js").PartEvent<
              | "text.start"
              | "reasoning.start"
              | "text.delta"
              | "reasoning.delta"
              | "text.end"
              | "reasoning.end"
            >;
          part = {
            ...identity,
            type: event.type.startsWith("text.") ? "text" : "reasoning",
            status: "status" in value ? value.status : "streaming",
            text:
              "text" in value
                ? value.text
                : "delta" in value
                  ? (previous && "text" in previous ? previous.text : "") +
                  value.delta
                  : "",
          };
        }
        if (index < 0) content.push(part);
        else content[index] = part;
        draft = { ...draft, content };
        return this.update({
          currentMessage: draft,
          messages: this.upsert(draft),
        });
      }
      case messageEvents.committed: {
        const message = event.payload.message;
        if (message.role === "assistant") {
          const draft = this.value.currentMessage;
          this.update({
            messages: this.value.messages.filter(
              (value) => value.id !== draft?.id,
            ),
            currentMessage: null,
          });
        }
        return this.update({ messages: this.upsert(message) });
      }
      case toolEvents.start: {
        const { toolExecutionId, toolCallId } = event.payload;
        const call = this.value.messages
          .flatMap((message) => message.content)
          .find(
            (part) =>
              part.type === "tool-call" && part.toolCallId === toolCallId,
          );
        const tool: StateTool = {
          id: toolExecutionId,
          toolCallId,
          name: call?.type === "tool-call" ? (call.name ?? "") : "",
          status: "running",
          progress: null,
          result: null,
          error: null,
        };
        return this.update({
          tools: [
            ...this.value.tools.filter((value) => value.id !== tool.id),
            tool,
          ],
        });
      }
      case toolEvents.update:
        return this.update({
          tools: this.value.tools.map((tool) =>
            tool.id === event.payload.toolExecutionId
              ? { ...tool, progress: event.payload.progress }
              : tool,
          ),
        });
      case toolEvents.end:
        return this.update({
          tools: this.value.tools.map((tool) =>
            tool.id === event.payload.toolExecutionId
              ? {
                ...tool,
                status: event.payload.status,
                result: event.payload.result,
              }
              : tool,
          ),
        });
      case toolEvents.error:
        return this.update({
          tools: this.value.tools.map((tool) =>
            tool.id === event.payload.toolExecutionId
              ? { ...tool, status: "failed", error: event.payload.error }
              : tool,
          ),
        });
      case modelEvents.error:
        if (event.payload.purpose === "auxiliary") return null;
        return this.update({ error: event.payload.error });
      case streamEvents.suspended:
        return this.update({
          status: "suspended",
          interrupt: event.payload.interrupt,
          tools: this.value.tools.map((tool) =>
            tool.id === event.payload.interrupt.actionRef?.toolExecutionId
              ? { ...tool, status: "suspended" }
              : tool,
          ),
        });
      case streamEvents.end: {
        let messages = this.value.messages;
        for (const message of event.payload.output)
          if (!messages.some((value) => value.id === message.id))
            messages = [...messages, message];
        return this.update({
          status: event.payload.status as StreamStatus,
          messages,
          interrupt: event.payload.interrupt,
          error: event.payload.error,
        });
      }
      case streamEvents.error:
        return this.update({
          status:
            (event.payload.persistedStatus as StreamStatus | null) ?? "failed",
          error: event.payload.error,
        });
      default:
        return null;
    }
  }
}
