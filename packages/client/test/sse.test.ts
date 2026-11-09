import { expect, test, vi } from "vitest";
import { TessarClient } from "../src/index.js";

const state = { status: "idle", messages: [], currentMessage: null, tools: [], interrupt: null, queuedInputs: 0, error: null };
const event = { type: "state_changed", timestamp: "2026-11-06T00:00:00Z", payload: { state }, agentId: "Việt Nam" };
const frame = `event: state_changed\ndata: ${JSON.stringify(event)}\n\n`;
function clientFor(response: Response) {
  return new TessarClient({ baseURL: "http://test", fetch: vi.fn<typeof fetch>().mockResolvedValue(response) });
}
function bytes(text: string) {
  return new ReadableStream<Uint8Array>({ start(c) { for (const byte of new TextEncoder().encode(text)) c.enqueue(Uint8Array.of(byte)); c.close(); } });
}

test.each(["\n", "\r\n", "\r"])("parses fragmented UTF-8 and %j line endings with multiline data", async ending => {
  const text = ': comment\nevent: other\ndata: ignored\n\nevent: state_changed\ndata: {\ndata: ' + JSON.stringify(event).slice(1) + '\n\n' + frame + 'data: incomplete';
  const client = clientFor(new Response(bytes(text.replaceAll("\n", ending)), { headers: { "content-type": "text/event-stream; charset=utf-8" } }));
  const stream = await client.getAgent("a").stream("hello");
  const events = [];
  for await (const value of stream) events.push(value);
  expect(events).toEqual([event, event]);
});

test("all streaming endpoints are eager and use JSON input without serializing signal", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(bytes(frame), { headers: { "content-type": "text/event-stream" } }));
  const client = new TessarClient({ baseURL: "http://test", headers: { authorization: "token" }, credentials: "include", fetch: fetcher });
  const signal = new AbortController().signal;
  const streams = [
    await client.getAgent("a").stream("hello", { signal }),
    await client.getAgent("a").resume({ threadId: "t", interruptId: "i", value: true }, { signal }),
    await client.getController("c").getSession("s").state.stream({ signal }),
  ];
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(["http://test/api/agents/a/stream", "http://test/api/agents/a/resume", "http://test/api/controllers/c/sessions/s/state/stream"]);
  expect(fetcher.mock.calls.map(([, init]) => init!.body)).toEqual(['{"input":"hello","options":{}}', '{"threadId":"t","interruptId":"i","value":true}', undefined]);
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ signal, credentials: "include" });
  expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get("authorization")).toBe("token");
  for (const stream of streams) for await (const value of stream) expect(value).toEqual(event);
});

test.each([
  new Response("oops", { headers: { "content-type": "text/plain" } }),
  new Response(null, { headers: { "content-type": "text/event-stream" } }),
  new Response(bytes('event: state_changed\ndata: not json\n\n'), { headers: { "content-type": "text/event-stream" } }),
  new Response(bytes('event: state_changed\ndata: {"payload":{}}\n\n'), { headers: { "content-type": "text/event-stream" } }),
])("rejects invalid SSE protocol", async response => {
  await expect((async () => { for await (const _ of await clientFor(response).getAgent("a").stream("hi")) { /* drain */ } })()).rejects.toMatchObject({ code: "InvalidResponse" });
});

test("break cancels/releases the reader and a stream cannot be consumed twice", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(frame)); }, cancel });
  const stream = await clientFor(new Response(body, { headers: { "content-type": "text/event-stream" } })).getAgent("a").stream("hi");
  for await (const _ of stream) break;
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
  expect(() => stream[Symbol.asyncIterator]()).toThrowError(expect.objectContaining({ code: "ConsumerAlreadyAttached" }));
});

test("abort before iteration releases the body and preserves reason", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const abort = new AbortController();
  const stream = await clientFor(new Response(body, { headers: { "content-type": "text/event-stream" } })).getAgent("a").stream("hi", { signal: abort.signal });
  const reason = new DOMException("Stop", "AbortError");
  abort.abort(reason);
  await vi.waitFor(() => expect(body.locked).toBe(false));
  expect(cancel).toHaveBeenCalledTimes(1);
  await expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(reason);
});

test("reader failures keep their native identity", async () => {
  const failure = new TypeError("network interrupted");
  const body = new ReadableStream<Uint8Array>({ start(c) { c.error(failure); } });
  const stream = await clientFor(new Response(body, { headers: { "content-type": "text/event-stream" } })).getAgent("a").stream("hi");
  await expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(failure);
});
