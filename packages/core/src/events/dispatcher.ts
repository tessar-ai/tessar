import { TessarError, errorInfo } from "../errors.js";
import {
  EventEnvelope,
  type AnyEvent,
  type EventContext,
  type PayloadOf,
  type ResultOf,
  type EventKind,
} from "./definition.js";
import type { HookContext } from "../plugins/context.js";
import type { RegistryLease } from "../plugins/registry.js";
import type { ProviderRequest } from "../models/contract.js";
import { validateProviderRequest } from "../models/provider-request.js";
import { validateDecision } from "./decision.js";
export async function dispatch<D extends AnyEvent>(
  lease: RegistryLease,
  definition: D,
  payload: PayloadOf<D>,
  context: Partial<HookContext> & EventContext,
  diagnostics: (
    error: ReturnType<typeof errorInfo>,
    context?: EventContext,
  ) => void,
  kind: EventKind = "notification",
): Promise<ResultOf<D>> {
  const hookContext: HookContext & EventContext = {
    ...context,
    registry: Object.freeze({
      get: <T = unknown>(kind: string, id: string) => lease.find<T>(kind, id),
      list: <T = unknown>(kind: string) => Object.freeze(lease.list<T>(kind)),
    }),
  };
  let current: unknown =
    kind === "transformation" ? payload : context.initialDecision;
  if (definition === "provider.request")
    current = validateProviderRequest(payload, payload as ProviderRequest);
  if (kind === "decision") validateDecision(definition, current);
  let handlerIndex = -1;
  const allowed = context.allowedHandlerIds as readonly string[] | undefined;
  const handlers = lease.handlers.filter(
    (h) => h.name === definition && (!allowed || allowed.includes(h.id)),
  );
  if (allowed)
    handlers.sort((a, b) => allowed.indexOf(a.id) - allowed.indexOf(b.id));
  for (const registration of handlers) {
    handlerIndex++;
    if (handlerIndex < ((context.startIndex as number | undefined) ?? 0))
      continue;
    if (
      context.signal?.aborted &&
      kind !== "notification" &&
      kind !== "barrier"
    )
      throw new TessarError("Cancelled", "Execution cancelled");
    try {
      const event = new EventEnvelope(
        definition,
        kind === "transformation" ? current : payload,
        context,
      );
      const result = await registration.handler(event, hookContext);
      if (kind === "decision") validateDecision(definition, result);
      if (kind === "transformation" && result !== undefined)
        current =
          definition === "provider.request"
            ? validateProviderRequest(result, payload as ProviderRequest)
            : result;
      if (kind === "decision" && result !== undefined) {
        const previous = current as { decision?: string } | undefined;
        if (
          !previous ||
          !["deny", "stop", "reject", "handled"].includes(
            previous.decision ?? "",
          )
        )
          current = result;
        if (context.onDecision)
          await (
            context.onDecision as (entry: {
              handlerId: string;
              index: number;
              decision: unknown;
            }) => Promise<void>
          )({
            handlerId: registration.id,
            index: handlerIndex,
            decision: current,
          });
        if ((result as { decision?: string }).decision === "suspend") break;
      }
    } catch (cause) {
      if (
        TessarError.isInstance(cause) &&
        cause.source === "tessar" &&
        ["StorageUnavailable", "CommitConflict", "OwnershipLost"].includes(
          cause.code,
        )
      )
        throw cause;
      const error =
        cause !== null && typeof cause === "object"
          ? cause
          : new Error(String(cause), { cause });
      const info = errorInfo(error, {
        source: "plugin",
        pluginId: registration.pluginId,
        eventId: definition,
      });
      if (kind !== "notification") throw error;
      try {
        diagnostics(info, context);
      } catch {
        /* diagnostics cannot control execution */
      }
    }
  }
  return current as ResultOf<D>;
}
