import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
const env = parseEnv(await readFile("D:/tessar-implement/.env", "utf8"));
const headers = { Authorization: "Bearer " + env.ARIZE_API_KEY, "Content-Type": "application/json" };
const projectsUrl = new URL("https://api.arize.com/v2/projects");
projectsUrl.searchParams.set("space_id", env.ARIZE_SPACE_ID);
const projectsResponse = await fetch(projectsUrl, { headers, signal: AbortSignal.timeout(15000) });
if (!projectsResponse.ok) throw Error("Projects API HTTP " + projectsResponse.status);
const project = (await projectsResponse.json()).projects.find(value => value.name === env.ARIZE_PROJECT_NAME);
if (!project) throw Error("Configured project not found");
const response = await fetch("https://api.arize.com/v2/spans?limit=100", {
  method: "POST", headers,
  body: JSON.stringify({ project_id: project.id, start_time: new Date(Date.now() - 3600000).toISOString(), end_time: new Date().toISOString() }),
  signal: AbortSignal.timeout(15000),
});
const payload = await response.json();
if (!response.ok) { console.log(JSON.stringify({ status: response.status, error: payload })); process.exit(1); }
await writeFile(new URL("arize-spans.json", import.meta.url), JSON.stringify(payload, null, 2));
console.log(JSON.stringify({ status: response.status, spans: payload.spans?.filter(span => span.kind === "LLM").slice(0, 3).map(span => {
  const a = span.attributes;
  return { name: span.name, kind: span.kind, id: span.context, parent: span.parent_id,
    inputMime: a?.["input.mime_type"], outputMime: a?.["output.mime_type"],
    inputPreview: String(a?.["input.value"]).slice(0, 60), outputPreview: String(a?.["output.value"]).slice(0, 60),
    inputRoles: a?.["llm.input_messages"]?.map(message => message["message.role"]),
    systemParts: a?.["llm.input_messages"]?.[0]?.["message.contents"]?.length,
    toolResults: a?.["llm.input_messages"]?.filter(message => message["message.role"] === "tool").map(message => ({ id: message["message.tool_call_id"], content: message["message.content"] })),
    outputToolCalls: a?.["llm.output_messages"]?.[0]?.["message.tool_calls"],
    duplicateGenAI: a?.["gen_ai.system_instructions"] !== undefined,
  };
}) }));
