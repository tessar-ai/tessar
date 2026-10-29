import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
const env = parseEnv(await readFile("D:/tessar-implement/.env", "utf8"));
const authorization = "Basic " + Buffer.from(env.LANGFUSE_PUBLIC_KEY + ":" + env.LANGFUSE_SECRET_KEY).toString("base64");
const base = env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";
async function get(path, params) {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error("Langfuse query HTTP " + response.status);
  return response.json();
}
const response = await get("/api/public/v2/observations", { fields: "core,basic,metadata,time", limit: "100", fromStartTime: new Date(Date.now() - 3600000).toISOString(), toStartTime: new Date(Date.now() + 1000).toISOString() });
const rows = (response.data ?? []).filter(row => row.metadata?.agentId === "session-assistant").map(row => ({ id: row.id, traceId: row.traceId, name: row.name, type: row.type, parent: row.parentObservationId, sessionId: row.sessionId, tessarSessionId: row.metadata?.sessionId, threadId: row.metadata?.threadId, streamId: row.metadata?.streamId, start: row.startTime }));
await writeFile(new URL("latest-session-ids.json", import.meta.url), JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows));
