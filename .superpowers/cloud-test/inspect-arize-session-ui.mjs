import { readFile, readdir, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
const directory = "D:/tessar-implement/logs/sessions/413d390e-83aa-4374-99b7-b88ff6965da9";
const files = await readdir(directory);
const events = (await Promise.all(files.map(file => readFile(directory + "/" + file, "utf8")))).flatMap(text => text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
const ids = [...new Set(events.map(event => event.threadId).filter(Boolean))];
const env = parseEnv(await readFile("D:/tessar-implement/.env", "utf8"));
const headers = { Authorization: "Bearer " + env.ARIZE_API_KEY, "Content-Type": "application/json" };
const projectResponse = await fetch("https://api.arize.com/v2/projects?space_id=" + encodeURIComponent(env.ARIZE_SPACE_ID), { headers, signal: AbortSignal.timeout(15000) });
if (!projectResponse.ok) throw Error("Projects HTTP " + projectResponse.status);
const project = (await projectResponse.json()).projects.find(project => project.name === env.ARIZE_PROJECT_NAME);
const response = await fetch("https://api.arize.com/v2/spans?limit=100", { method: "POST", headers, body: JSON.stringify({ project_id: project.id, start_time: new Date(Date.now() - 7200000).toISOString(), end_time: new Date().toISOString() }), signal: AbortSignal.timeout(15000) });
if (!response.ok) throw Error("Spans HTTP " + response.status);
const payload = await response.json();
const rows = payload.spans.filter(row => ids.includes(row.attributes["session.id"]));
await writeFile(new URL("arize-session-ui-result.json", import.meta.url), JSON.stringify({ ids, rows }, null, 2));
const roles = value => {
  try { const messages = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(messages) ? messages.map(message => message.role) : undefined; }
  catch { return undefined; }
};
console.log(JSON.stringify({ threadIds: ids, logEvents: events.length, received: rows.length, spans: rows.map(row => ({
  id: row.context?.span_id, trace: row.context?.trace_id, parent: row.parent_id,
  name: row.name, kind: row.kind, start: row.start_time,
  sessionId: row.attributes["session.id"],
  inputMime: row.attributes["input.mime_type"],
  inputRoles: roles(row.attributes["input.value"]),
  systemInRootInput: roles(row.attributes["input.value"])?.includes("system"),
  structuredMessageRoles: row.attributes["llm.input_messages"]?.map(message => message["message.role"]),
})) }, null, 2));
