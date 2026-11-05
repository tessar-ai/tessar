import type { Context, Hono } from "hono";
import { threadDescriptor } from "../descriptors.js";
import { body, query, required, bad, safeError, ROUTE_PARAM, HTTP_STATUS, PAGE_QUERY_FIELDS } from "../protocol/http.js";
import type { SessionRegistry } from "../runtime/session-registry.js";
import { S } from "./sessions.js";

const THREADS_PATH = S + "/threads";
export const T = THREADS_PATH + "/:threadId";
const HISTORY_QUERY_FIELDS = [...PAGE_QUERY_FIELDS, "atCheckpointId"] as const;
const EXECUTION_QUERY_FIELDS = ["status", ...PAGE_QUERY_FIELDS] as const;
export function registerThreads(app: Hono, sessions: () => SessionRegistry) {
  const get = (c: Context) => sessions().get(c.req.param(ROUTE_PARAM.CONTROLLER_ID)!, c.req.param(ROUTE_PARAM.SESSION_ID)!);
  const thread = async (c: Context) => required(await (await get(c)).thread.get(c.req.param(ROUTE_PARAM.THREAD_ID)!));
  app.post(THREADS_PATH, async c => c.json(threadDescriptor(await (await get(c)).thread.create(
    await body(c, ["id", "title", "messages", "metadata"]))), HTTP_STATUS.CREATED));
  app.get(THREADS_PATH, async c => c.json(await (await get(c)).thread.list(query(c, PAGE_QUERY_FIELDS))));
  app.get(T, async c => c.json(threadDescriptor(await thread(c))));
  app.post(S + "/thread/switch", async c => {
    const { threadId } = await body(c, ["threadId"]);
    if (typeof threadId !== "string") bad("threadId is required");
    return c.json(threadDescriptor(await (await get(c)).thread.switch(threadId)));
  });
  app.post(T + "/rename", async c => {
    const { title } = await body(c, ["title"]);
    if (typeof title !== "string") bad("title is required");
    await (await get(c)).thread.rename(title, { threadId: c.req.param(ROUTE_PARAM.THREAD_ID) }); return c.body(null, HTTP_STATUS.NO_CONTENT);
  });
  app.post(T + "/fork", async c => c.json(threadDescriptor(await (await get(c)).thread.fork({
    ...await body(c, ["id", "atCheckpointId", "atMessageId", "metadata"]), threadId: c.req.param(ROUTE_PARAM.THREAD_ID),
  })), HTTP_STATUS.CREATED));
  app.delete(T, async c => { await (await get(c)).thread.delete({ threadId: c.req.param(ROUTE_PARAM.THREAD_ID) }); return c.body(null, HTTP_STATUS.NO_CONTENT); });
  app.post(T + "/purge", async c => { await (await get(c)).thread.purge({ threadId: c.req.param(ROUTE_PARAM.THREAD_ID) }); return c.body(null, HTTP_STATUS.NO_CONTENT); });
  app.get(T + "/snapshot", async c => c.json(await (await thread(c)).snapshot()));
  app.get(T + "/history", async c => c.json(await (await thread(c)).getHistory(query(c, HISTORY_QUERY_FIELDS))));
  app.get(T + "/checkpoints", async c => c.json(await (await thread(c)).listCheckpoints(query(c, PAGE_QUERY_FIELDS))));
  app.get(T + "/checkpoints/:checkpointId", async c => c.json(required(await (await thread(c)).getCheckpoint(c.req.param(ROUTE_PARAM.CHECKPOINT_ID)!))));
  app.get(T + "/streams/:streamId", async c => {
    const record = required(await (await thread(c)).getStream(c.req.param(ROUTE_PARAM.STREAM_ID)!));
    return c.json({ ...record, error: safeError(record.error) });
  });
  app.get(T + "/interrupts/:interruptId", async c => c.json(required(await (await thread(c)).getInterrupt(c.req.param(ROUTE_PARAM.INTERRUPT_ID)!))));
  for (const [path, operation] of [
    ["streams", "listStreams"], ["turns", "listTurns"], ["model-attempts", "listModelAttempts"],
    ["tool-executions", "listToolExecutions"], ["interrupts", "listInterrupts"],
  ] as const) app.get(T + "/" + path, async c => {
    const page = await (await thread(c))[operation](query(c, EXECUTION_QUERY_FIELDS));
    return c.json({ ...page, items: page.items.map(record => "error" in record ? { ...record, error: safeError(record.error) } : record) });
  });
}
