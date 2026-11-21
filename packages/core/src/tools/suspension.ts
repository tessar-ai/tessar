import { assertJson, immutable, type JsonValue } from "../helpers/json.js";

/** A tool control value; ordinary JSON is never interpreted as suspension. */
export class ToolSuspension {
  readonly payload: JsonValue;
  constructor(payload: JsonValue) {
    assertJson(payload);
    this.payload = immutable(payload);
    Object.freeze(this);
  }
}
