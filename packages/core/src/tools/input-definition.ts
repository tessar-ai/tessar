import type { JsonObject } from "../helpers/json.js";
export interface InputDefinition<T> {
  readonly jsonSchema: JsonObject;
  parse(value: unknown): T;
}
