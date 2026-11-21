import type { JsonObject, JsonValue } from "../helpers/json.js";
export type ContentPart = (
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "reasoning";
      readonly text: string;
      readonly providerState?: JsonValue;
    }
  | {
      readonly type: "tool-call";
      readonly toolCallId: string;
      readonly name: string;
      readonly arguments: JsonObject;
    }
  | {
      readonly type: "image" | "audio" | "file";
      readonly mediaType: string;
      readonly data: string;
    }
  | { readonly type: "data"; readonly data: JsonValue }
) & { readonly metadata?: JsonObject };
