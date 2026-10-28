import type { ModelPartChunk } from "../src/models/contract.js";
const time = "2026-10-26T00:00:00.000Z";
export function start(
  messageId: string,
  partId = "text",
  kind: "text" | "reasoning" = "text",
  partIndex = 0,
): ModelPartChunk {
  return {
    type: `${kind}.start`,
    messageId,
    partId,
    partIndex,
    startedAt: time,
    boundary: "observed",
  };
}
export function delta(
  messageId: string,
  value: string,
  partId = "text",
  kind: "text" | "reasoning" = "text",
  partIndex = 0,
): ModelPartChunk {
  return { type: `${kind}.delta`, messageId, partId, partIndex, delta: value };
}
export function end(
  messageId: string,
  value: string,
  partId = "text",
  kind: "text" | "reasoning" = "text",
  partIndex = 0,
): ModelPartChunk {
  return {
    type: `${kind}.end`,
    messageId,
    partId,
    partIndex,
    startedAt: time,
    endedAt: time,
    status: "completed",
    text: value,
    boundary: "observed",
  };
}
