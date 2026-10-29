import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
const env = parseEnv(await readFile("D:/tessar-implement/.env", "utf8"));
const files = await readdir("D:/tessar-implement/logs", { recursive: true, withFileTypes: true });
let latest;
for (const file of files) {
  if (!file.isFile() || !file.name.endsWith(".log")) continue;
  for (const line of (await readFile(join(file.parentPath, file.name), "utf8")).split(/\r?\n/)) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "model.end" && entry.threadId && (!latest || entry.timestamp > latest.timestamp)) latest = entry;
  }
}
if (!latest) throw Error("No latest trace log");
const traceId = createHash("sha256").update(latest.threadId).digest("hex").slice(0, 32);
const url = new URL(`/api/public/v2/observations`, env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com");
url.searchParams.set("traceId", traceId);
url.searchParams.set("fields", "core,basic,io,metadata");
url.searchParams.set("fromStartTime", new Date(Date.parse(latest.timestamp) - 300000).toISOString());
url.searchParams.set("toStartTime", new Date(Date.parse(latest.timestamp) + 300000).toISOString());
url.searchParams.set("limit", "100");
const response = await fetch(url, { headers: { Authorization: "Basic " + Buffer.from(env.LANGFUSE_PUBLIC_KEY + ":" + env.LANGFUSE_SECRET_KEY).toString("base64") }, signal: AbortSignal.timeout(15000) });
console.log(JSON.stringify({ platform: "Langfuse", status: response.status, traceId }));
if (response.ok) {
  const data = await response.json();
  const observations = data.data ?? [];
  console.log(JSON.stringify({ observations: observations.map(value => {
    let input = value.input; if (typeof input === "string") { try { input=JSON.parse(input); } catch {} }
    return { id: value.id, name: value.name, type: value.type, parent: value.parentObservationId,
      metadataTurn: value.metadata?.turnId,
      availableTools: input?.tools?.map(tool => tool.name),
      hasToolDescription: !!(value.metadata?.toolDescription ?? value.metadata?.tool?.description),
    };
  }) }));
} else process.exitCode = 1;

