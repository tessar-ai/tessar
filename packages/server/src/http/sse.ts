import { stateChanged, type EventEnvelope, type RuntimeState } from "@tessar/core";
import { safeState } from "./protocol.js";

export type StateEvent = EventEnvelope<{ state: RuntimeState }>;
export type StateSubscription = (push: (event: StateEvent) => void, end: () => void) => () => void;
export const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache" } as const;
const encoder = new TextEncoder();

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
  private closed = false;
  open(subscribe: StateSubscription, disconnect?: () => void): ReadableStream<Uint8Array> {
    if (this.closed) return new ReadableStream({ start(stream) { stream.close(); } });
    let controller!: TransformStreamDefaultController<Uint8Array>;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
      start(stream) { controller = stream; },
    });
    const sink = writable.getWriter();
    let sequence = 0;
    const writer = new LatestStateWriter(event => {
      const data = JSON.stringify({ ...event, payload: { state: safeState(event.payload.state) } });
      return sink.write(encoder.encode(`event: ${stateChanged}\ndata: ${data}\nid: ${++sequence}\n\n`));
    });
    const terminate = () => { writer.cancel(); controller.terminate(); };
    const stop = () => { terminate(); disconnect?.(); };
    this.connections.add(stop);
    void sink.closed.catch(() => writer.cancel());
    let unsubscribe: (() => void) | undefined;
    try { unsubscribe = subscribe(event => writer.push(event), () => writer.end()); }
    catch (error) { this.connections.delete(stop); terminate(); throw error; }
    void writer.done.then(async () => {
      this.connections.delete(stop);
      unsubscribe();
      await sink.close().catch(() => { });
    }).catch(error => console.error(error));
    return readable;
  }
  close(): void { this.closed = true; for (const stop of this.connections) stop(); this.connections.clear(); }
}
