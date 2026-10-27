import { fail, requireId } from "../errors.js";
import type { JsonValue } from "../json.js";
import type { InputDefinition } from "../tools/input-definition.js";
import type {
  ControlDecision,
  ResolvedDecision,
  SuspendDecision,
} from "../events/type.js";
import type { PluginStateContext } from "../state/plugin-state.js";
import type { ExecutionHookContext } from "./tracked-effects.js";
export interface InterruptionDefinition<
  R = any,
  D extends ResolvedDecision = ResolvedDecision,
  P extends JsonValue = JsonValue,
> {
  readonly id: string;
  readonly version: number;
  readonly response: InputDefinition<R>;
  readonly payload?: InputDefinition<P>;
  readonly resolve: (response: R, payload: P) => D;
}
export function defineInterruption<
  R,
  D extends ResolvedDecision,
  P extends JsonValue = JsonValue,
>(
  definition: InterruptionDefinition<R, D, P>,
): InterruptionDefinition<R, D, P> {
  requireId(definition.id);
  if (!Number.isInteger(definition.version) || definition.version < 1)
    fail("InvalidConfiguration", "Invalid interruption version");
  return Object.freeze({ ...definition });
}
export interface DecisionHookContext<
  D extends ControlDecision = ControlDecision,
> extends ExecutionHookContext {
  readonly state: PluginStateContext;
  readonly signal: AbortSignal;
  readonly threadId: string;
  readonly streamId: string;
  suspend<R, P extends JsonValue>(
    definition: InterruptionDefinition<R, Exclude<D, SuspendDecision>, P>,
    payload: P,
  ): SuspendDecision;
}
export class Suspension extends Error {
  constructor() {
    super("Execution suspended");
  }
}
