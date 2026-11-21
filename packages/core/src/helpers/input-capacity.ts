import { fail } from "../errors.js";

const MAX_PENDING_INPUTS = 100;
const MAX_PENDING_INPUT_BYTES = 4 * 1024 * 1024;
const INPUT_QUEUE_FULL = "InputQueueFull";
const encoder = new TextEncoder();

function full(): never { fail(INPUT_QUEUE_FULL, "Pending input capacity exceeded"); }

/** Inspect data properties without invoking caller getters before the normal codec snapshot. */
export function assertInputSize(value: unknown, remaining = MAX_PENDING_INPUT_BYTES): void {
  const parents = new Set<object>();
  const text = (value: string) => {
    if (value.length > remaining) full();
    remaining -= encoder.encode(value).byteLength;
    if (remaining < 0) full();
  };
  const visit = (value: unknown): void => {
    remaining -= 2;
    if (remaining < 0) full();
    if (typeof value === "string") text(value);
    else if (value && typeof value === "object" && !parents.has(value)) {
      parents.add(value);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (descriptor.enumerable && "value" in descriptor) { text(key); visit(descriptor.value); }
      }
      parents.delete(value);
    }
  };
  visit(value);
}

export class InputCapacity {
  private count = 0;
  private bytes = 0;
  check(value: unknown): void {
    if (this.count >= MAX_PENDING_INPUTS) full();
    assertInputSize(value, MAX_PENDING_INPUT_BYTES - this.bytes);
  }
  reserve(value: unknown): () => void {
    this.check(value);
    const json = JSON.stringify(value);
    if (json.length > MAX_PENDING_INPUT_BYTES - this.bytes) full();
    const bytes = encoder.encode(json).byteLength;
    if (this.bytes + bytes > MAX_PENDING_INPUT_BYTES) full();
    this.count++;
    this.bytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count--;
      this.bytes -= bytes;
    };
  }
}
