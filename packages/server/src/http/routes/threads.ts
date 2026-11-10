import type { Context, Hono } from "hono";
import { threadDescriptor } from "../descriptors.js";
import { body, query, required, bad, safeError, ROUTE_PARAM, HTTP_STATUS, PAGE_QUERY_FIELDS } from "../protocol.js";
import type { SessionRegistry } from "../../runtime/session-registry.js";
import { SESSION_PATH } from "./sessions.js";
import { authScope } from "../access.js";

const THREADS_PATH = SESSION_PATH + "/threads";
export const THREAD_PATH = THREADS_PATH + "/:threadId";
const HISTORY_QUERY_FIELDS = [...PAGE_QUERY_FIELDS, "atCheckpointId"] as const;
const EXECUTION_QUERY_FIELDS = ["status", ...PAGE_QUERY_FIELDS] as const;
export function registerThreads(app: Hono, sessions: () => SessionRegistry) {
  const get = (c: Context) => sessions().get(c.req.param(ROUTE_PARAM.CONTROLLER_ID)!, c.req.param(ROUTE_PARAM.SESSION_ID)!, authScope(c));
  const thread = async (c: Context) => required(await (await get(c)).thread.get(c.req.param(ROUTE_PARAM.THREAD_ID)!));
  app.post(THREADS_PATH, async c => c.json(threadDescriptor(await (await get(c)).thread.create(
    await body(c, ["id", "title", "messages", "metadata"]))), HTTP_STATUS.CREATED));
  app.get(THREADS_PATH, async c => c.json(await (await get(c)).thread.list(query(c, PAGE_QUERY_FIELDS))));
  app.get(THREAD_PATH, async c => c.json(threadDescriptor(await thread(c))));
  app.post(SESSION_PATH + "/thread/switch", async c => {
    const { threadId } = await body(c, ["threadId"]);
    if (typeof threadId !== "string") bad("threadId is required");
    return c.json(threadDescriptor(await (await get(c)).thread.switch(threadId)));
  });
  app.post(THREAD_PATH + "/rename", async c => {
    const { title } = await body(c, ["title"]);
    if (typeof title !== "string") bad("title is required");
    await (await get(c)).thread.rename(title, { threadId: c.req.param(ROUTE_PARAM.THREAD_ID) }); return c.body(null, HTTP_STATUS.NO_CONTENT);
  });
  app.post(THREAD_PATH + "/fork", async c => c.json(threadDescriptor(await (await get(c)).thread.fork({
    ...await body(c, ["id", "atCheckpointId", "atMessageId", "metadata"]), threadId: c.req.param(ROUTE_PARAM.THREAD_ID),
  })), HTTP_STATUS.CREATED));
  app.delete(THREAD_PATH, async c => { await (await get(c)).thread.delete({ threadId: c.req.param(ROUTE_PARAM.THREAD_ID) }); return c.body(null, HTTP_STATUS.NO_CONTENT); });
  app.post(THREAD_PATH + "/purge", async c => { await (await get(c)).thread.purge({ threadId: c.req.param(ROUTE_PARAM.THREAD_ID) }); return c.body(null, HTTP_STATUS.NO_CONTENT); });
  app.get(THREAD_PATH + "/snapshot", async c => c.json(await (await thread(c)).snapshot()));
  app.get(THREAD_PATH + "/history", async c => c.json(await (await thread(c)).getHistory(query(c, HISTORY_QUERY_FIELDS))));
  app.get(THREAD_PATH + "/checkpoints", async c => c.json(await (await thread(c)).listCheckpoints(query(c, PAGE_QUERY_FIELDS))));
  app.get(THREAD_PATH + "/checkpoints/:checkpointId", async c => c.json(required(await (await thread(c)).getCheckpoint(c.req.param(ROUTE_PARAM.CHECKPOINT_ID)!))));
  app.get(THREAD_PATH + "/streams/:streamId", async c => {
    const record = required(await (await thread(c)).getStream(c.req.param(ROUTE_PARAM.STREAM_ID)!));
    return c.json({ ...record, error: safeError(record.error) });
  });
  app.get(THREAD_PATH + "/interrupts/:interruptId", async c => c.json(required(await (await thread(c)).getInterrupt(c.req.param(ROUTE_PARAM.INTERRUPT_ID)!))));
  for (const [path, operation] of [
    ["streams", "listStreams"], ["turns", "listTurns"], ["model-attempts", "listModelAttempts"],
    ["tool-executions", "listToolExecutions"], ["interrupts", "listInterrupts"],
  ] as const) app.get(THREAD_PATH + "/" + path, async c => {
    const page = await (await thread(c))[operation](query(c, EXECUTION_QUERY_FIELDS));
    return c.json({ ...page, items: page.items.map(record => "error" in record ? { ...record, error: safeError(record.error) } : record) });
  });
}
