import { CLIENT_ERROR_CODE, TessarClientError } from "./errors.js";
import { MIME, HEADER, isObject } from "./transport.js";
import type { StateEvent } from "./types.js";

const STATE_CHANGED = "state_changed";
const ABORT_EVENT = "abort";
const SSE_FIELD = { EVENT: "event", DATA: "data" } as const;
export interface StateStream extends AsyncIterable<StateEvent> {}

export async function stateStream(response: Response, signal?: AbortSignal): Promise<StateStream> {
  if (response.headers.get(HEADER.CONTENT_TYPE)?.split(";")[0]?.trim().toLowerCase() !== MIME.SSE || !response.body) {
    await response.body?.cancel();
    throw new TessarClientError(CLIENT_ERROR_CODE.INVALID_RESPONSE, "Expected an SSE response body");
  }
  return new StreamReader(response.body.getReader(), signal);
}

class StreamReader implements StateStream {
  private consumed = false;
  private cleanup?: Promise<void>;
  private readonly iterator: AsyncGenerator<StateEvent>;
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>, private readonly signal?: AbortSignal) {
    this.iterator = this.decode();
    if (signal?.aborted) this.abort();
    else signal?.addEventListener(ABORT_EVENT, this.abort, { once: true });
  }
  private readonly abort = (): void => { void this.stop(); };
  private stop(): Promise<void> {
    return this.cleanup ??= (async () => {
      this.signal?.removeEventListener(ABORT_EVENT, this.abort);
      try { await this.reader.cancel(); } catch { /* Preserve the read/fetch failure, not a cleanup error. */ }
      finally { this.reader.releaseLock(); }
    })();
  }
  [Symbol.asyncIterator](): AsyncIterator<StateEvent> {
    if (this.consumed) throw new TessarClientError(CLIENT_ERROR_CODE.CONSUMER_ALREADY_ATTACHED, "State stream already has a consumer");
    this.consumed = true;
    return {
      next: async () => {
        this.signal?.throwIfAborted();
        return this.iterator.next();
      },
      return: async () => {
        await this.stop();
        return this.iterator.return(undefined);
      },
    };
  }
  private async *decode(): AsyncGenerator<StateEvent> {
    const decoder = new TextDecoder();
    let line = "", event = "", data: string[] = [], skipLF = false;
    try {
      while (true) {
        this.signal?.throwIfAborted();
        const { value, done } = await this.reader.read();
        this.signal?.throwIfAborted();
        const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
        for (const character of text) {
          if (skipLF && character === "\n") { skipLF = false; continue; }
          skipLF = character === "\r";
          if (character !== "\r" && character !== "\n") { line += character; continue; }
          if (!line) {
            if (event === STATE_CHANGED && data.length) yield parseEvent(data.join("\n"));
            event = ""; data = [];
          } else if (!line.startsWith(":")) {
            const colon = line.indexOf(":");
            const field = colon < 0 ? line : line.slice(0, colon);
            let content = colon < 0 ? "" : line.slice(colon + 1);
            if (content.startsWith(" ")) content = content.slice(1);
            if (field === SSE_FIELD.EVENT) event = content;
            else if (field === SSE_FIELD.DATA) data.push(content);
          }
          line = "";
        }
        if (done) return;
      }
    } finally { await this.stop(); }
  }
}

function parseEvent(text: string): StateEvent {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (cause) { throw new TessarClientError(CLIENT_ERROR_CODE.INVALID_RESPONSE, "Invalid SSE JSON", { cause }); }
  if (!isObject(value) || value.type !== STATE_CHANGED || typeof value.timestamp !== "string" ||
    !isObject(value.payload) || !isObject(value.payload.state) ||
    typeof value.payload.state.status !== "string" || !Array.isArray(value.payload.state.messages) ||
    !Array.isArray(value.payload.state.tools) || typeof value.payload.state.queuedInputs !== "number")
    throw new TessarClientError(CLIENT_ERROR_CODE.INVALID_RESPONSE, "Invalid state event envelope");
  return value as StateEvent;
}
