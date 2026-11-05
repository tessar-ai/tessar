import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import { stateChanged, type EventEnvelope, type RuntimeState } from "@tessar/core";
import { safeState } from "./http.js";

export type StateEvent = EventEnvelope<{ state: RuntimeState }>;

export class LatestStateWriter {
  private pending?: StateEvent;
  private writing = false;
  private ending = false;
  private stopped = false;
  private resolve!: () => void;
  readonly done = new Promise<void>(resolve => { this.resolve = resolve; });
  constructor(private readonly write: (event: StateEvent) => Promise<void>) { }
  push(event: StateEvent): void {
    if (this.stopped || this.ending) return;
    this.pending = event;
    void this.flush();
  }
  end(): void { this.ending = true; void this.flush(); }
  cancel(): void { this.stopped = true; this.pending = undefined; this.resolve(); }
  private async flush(): Promise<void> {
    if (this.writing || this.stopped) return;
    this.writing = true;
    try {
      while (this.pending && !this.stopped) {
        const event = this.pending;
        this.pending = undefined;
        await this.write(event);
      }
      if (this.ending) this.cancel();
    } catch { this.cancel(); }
    finally { this.writing = false; }
  }
}

export class SseTransport {
  private readonly connections = new Set<() => void>();
  response(c: Context, subscribe: (push: (event: StateEvent) => void, end: () => void) => (() => void)): Response {
    return streamSSE(c, async stream => {
      let sequence = 0;
      const writer = new LatestStateWriter(event => stream.writeSSE({
        event: stateChanged, id: String(++sequence),
        data: JSON.stringify({ ...event, payload: { state: safeState(event.payload.state) } })
      }));
      const stop = () => { writer.cancel(); };
      this.connections.add(stop);
      stream.onAbort(stop);
      const unsubscribe = subscribe(event => writer.push(event), () => writer.end());
      try { await writer.done; }
      finally { unsubscribe(); this.connections.delete(stop); }
    });
  }
  close(): void { for (const stop of this.connections) stop(); this.connections.clear(); }
}
