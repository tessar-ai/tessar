import { TessarError, errorInfo, MessageCodec, normalizeContent, normalizeScope, type ErrorInfo, type RuntimeState } from "@tessar/core";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { TessarServerError, SERVER_ERROR_CODE } from "../errors.js";

export const HTTP_STATUS = {
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
} as const;

export const HTTP_ERROR_CODE = {
  INVALID_REQUEST: "InvalidRequest",
  NOT_FOUND: "NotFound",
  COMMIT_CONFLICT: "CommitConflict",
} as const;

export const HTTP_ERROR_MESSAGE = {
  NOT_FOUND: "Resource not found",
  REQUEST_FAILED: "Runtime request failed",
  INPUT_REQUIRED: "input is required",
  CONTINUATION_REQUIRED: "Missing continuation fields",
  REASON_MUST_BE_STRING: "reason must be a string",
} as const;

export const ROUTE_PARAM = {
  AGENT_ID: "agentId",
  CONTROLLER_ID: "controllerId",
  SESSION_ID: "sessionId",
  THREAD_ID: "threadId",
  STREAM_ID: "streamId",
  CHECKPOINT_ID: "checkpointId",
  INTERRUPT_ID: "interruptId",
  NAMESPACE: "namespace",
  RECORD_ID: "recordId",
} as const;

export const PAGE_QUERY_FIELDS = ["limit", "cursor"] as const;
export const SCOPED_PAGE_QUERY_FIELDS = ["scope", ...PAGE_QUERY_FIELDS] as const;
const STRING_FIELDS = ["id", "threadId", "interruptId", "streamId", "modelId", "level", "atCheckpointId", "atMessageId", "reason", "title", "tagName"];
const EMPTY_STRING_FIELDS = ["reason", "title"];
const OBJECT_FIELDS = ["metadata", "scope", "options", "modelOptions", "context", "limits", "attributes"];
const ERROR_STATUS_BY_CODE = new Map<string, ContentfulStatusCode>([
  ...[
    HTTP_ERROR_CODE.INVALID_REQUEST, "InvalidConfiguration", "InvalidCursor", "InvalidData", "InvalidEvent",
    "InvalidMessage", "InvalidResumeResponse", "InvalidUsage", "SchemaIncompatible", "UnknownTool",
    "UnsupportedBoundary", "UnsupportedModelSelection", "UnsupportedOption",
  ].map(code => [code, HTTP_STATUS.BAD_REQUEST] as const),
  ...[
    HTTP_ERROR_CODE.NOT_FOUND, SERVER_ERROR_CODE.AGENT_NOT_FOUND, SERVER_ERROR_CODE.CONTROLLER_NOT_FOUND,
    "CheckpointNotFound", "InterruptNotFound", "StreamNotFound", "ThreadNotFound",
  ].map(code => [code, HTTP_STATUS.NOT_FOUND] as const),
  ...[
    HTTP_ERROR_CODE.COMMIT_CONFLICT, "AgentAlreadyBound", "AlreadyResumed", "AlreadyTerminal", "Cancelled",
    "ConsumerAlreadyAttached", "InvalidTransition", "ModelContextIncompatible", "OperationDenied", "OwnerActive",
    "OwnershipLost", "PluginStateIncompatible", "RecoveryRequired", "RegistrationConflict", "ResumeIncompatible",
    "SessionAgentMismatch", "SessionBusy", "StreamLimit", "ThreadBusy", "ThreadNotDeleted", "ThreadNotSelected",
    "ThreadReferenced", "ThreadScopeMismatch", "UnsafeForkPoint",
  ].map(code => [code, HTTP_STATUS.CONFLICT] as const),
  ...[
    "ControllerNotReady", SERVER_ERROR_CODE.DISPOSED, "MissingModel", "MissingProvider", "StorageUnavailable",
  ].map(code => [code, HTTP_STATUS.SERVICE_UNAVAILABLE] as const),
]);

export function bad(message: string): never { throw new TessarServerError(HTTP_ERROR_CODE.INVALID_REQUEST, message); }
export function required<T>(value: T | null | undefined): T {
  if (value == null) throw new TessarServerError(HTTP_ERROR_CODE.NOT_FOUND, HTTP_ERROR_MESSAGE.NOT_FOUND);
  return value;
}
export async function body(c: Context, allowed: readonly string[]): Promise<Record<string, any>> {
  let value: unknown;
  try { value = await c.req.json(); } catch { return bad("Expected JSON object"); }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key))) bad("Unexpected request fields");
  const data = value as Record<string, any>;
  validateFields(data);
  return data;
}
export function validateFields(data: Record<string, unknown>): void {
  for (const [key, field] of Object.entries(data)) {
    if (STRING_FIELDS.includes(key) &&
      (typeof field !== "string" || (!EMPTY_STRING_FIELDS.includes(key) && !field.trim()))) bad(key + " must be a string");
    if (OBJECT_FIELDS.includes(key) &&
      (!field || typeof field !== "object" || Array.isArray(field))) bad(key + " must be an object");
    if (key === "scope") normalizeScope(field as Parameters<typeof normalizeScope>[0]);
    if (key === "persist" && typeof field !== "boolean") bad("persist must be boolean");
    if (key === "input") validateInput(field);
    if (key === "messages") {
      if (!Array.isArray(field)) bad("messages must be an array");
      for (const message of field) MessageCodec.decode(message);
    }
    if (key === "content") normalizeContent(field as Parameters<typeof normalizeContent>[0]);
  }
}
export function validateInput(value: unknown): void {
  if (typeof value === "string") return;
  if (!value || typeof value !== "object") bad("input must be text or MessageData");
  for (const message of Array.isArray(value) ? value : [value]) MessageCodec.decode(message);
}
export function query(c: Context, allowed: readonly string[]): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    if (!allowed.includes(key) || values.length !== 1) bad("Unexpected query parameter");
    const value = values[0]!;
    if (key === "limit") {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 200) bad("Invalid limit");
      result[key] = Number(value);
    } else if (key === "scope") {
      try { result[key] = normalizeScope(JSON.parse(value)); } catch { bad("Invalid scope JSON"); }
    } else result[key] = value;
  }
  return result;
}
export function httpError(error: unknown, c: Context): Response {
  const info = errorInfo(error);
  let status: ContentfulStatusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR;
  if (info.source === "provider") status = HTTP_STATUS.BAD_GATEWAY;
  else if (info.source === "storage") status = HTTP_STATUS.SERVICE_UNAVAILABLE;
  else if (info.source === "tessar" && TessarError.isInstance(error)) {
    status = ERROR_STATUS_BY_CODE.get(info.code) ?? HTTP_STATUS.INTERNAL_SERVER_ERROR;
  }
  if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR) console.error(error);
  return c.json({ error: safeError(info, status < HTTP_STATUS.INTERNAL_SERVER_ERROR) }, status);
}
export function safeError(info: ErrorInfo | null, exposeMessage = false): ErrorInfo | null {
  if (!info) return null;
  const details = info.details && Object.fromEntries(Object.entries(info.details).filter(([key, value]) =>
    ["status", "requestID", "request_id", "type", "param"].includes(key) &&
    ["string", "number", "boolean"].includes(typeof value)));
  return {
    source: info.source, name: info.name, code: info.code, message: exposeMessage ? info.message : HTTP_ERROR_MESSAGE.REQUEST_FAILED, retryable: info.retryable,
    providerId: info.providerId, modelId: info.modelId, pluginId: info.pluginId, eventId: info.eventId,
    toolName: info.toolName, backendId: info.backendId, details: details && Object.keys(details).length ? details : undefined
  };
}
export function safeState(state: RuntimeState): RuntimeState {
  return { ...state, error: safeError(state.error), tools: state.tools.map(tool => ({ ...tool, error: safeError(tool.error) })) };
}
