import { readFile, writeFile } from "node:fs/promises";
const edit = async (path, action) => writeFile(path, action((await readFile(path, "utf8")).replaceAll("\r\n", "\n")));
await edit("packages/opentelemetry/test/adapters.test.ts", source => {
  let s = source.replaceAll("Arize", "Laminar").replaceAll("arize", "laminar");
  s = s.replace('              spaceId: "test-space",\n              projectName: "test-project",\n', "");
  const start = s.indexOf("    const laminarGeneration =");
  const end = s.indexOf("    const genericResource =", start);
  if (start < 0 || end < 0) throw Error("Adapter test anchors missing");
  s = s.slice(0, start) + `    const lmGeneration = laminar.find(span => span.spanId === generation.spanId)!;
    expect(read(lmGeneration.attributes, "lmnr.span.type")).toBe("LLM");
    expect(read(lmGeneration.attributes, "gen_ai.system")).toBe("scripted");
    expect(read(lmGeneration.attributes, "llm.usage.total_tokens")).toBe(120);
    expect(read(lmGeneration.attributes, "gen_ai.usage.reasoning_tokens")).toBe(5);
    const lmInput = JSON.parse(String(read(lmGeneration.attributes, "lmnr.span.input")));
    expect(lmInput.map((message: { role: string }) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(lmInput[0].parts[0]).toEqual({ type: "text", content: "You are a weather assistant.\\n\\nUse Celsius." });
    expect(lmInput[3].parts[0]).toEqual({ type: "tool_call_response", id: "weather-call", result: { condition: "sunny" } });
    expect(JSON.parse(String(read(lmGeneration.attributes, "lmnr.span.output")))[0].parts).toEqual([
      { type: "thinking", content: "The tool reported sunny weather." },
      { type: "text", content: "It is sunny" },
    ]);
    const lmTurn = laminar.find(span => span.name === "turn 2")!;
    expect(read(lmTurn.attributes, "lmnr.span.type")).toBe("DEFAULT");
    expect(JSON.parse(String(read(lmTurn.attributes, "lmnr.span.input")))[0]).toEqual({
      role: "system", content: [{ type: "text", text: "You are a weather assistant.\\n\\nUse Celsius." }],
    });
    expect(JSON.parse(String(read(lmTurn.attributes, "lmnr.span.output")))).toEqual([
      { role: "assistant", content: [
        { type: "reasoning", text: "The tool reported sunny weather." },
        { type: "text", text: "It is sunny" },
      ] },
    ]);
    expect(laminar.some(span => read(span.attributes, "lmnr.span.type") === "TOOL")).toBe(true);
    const lmResource = received.get("/laminar/v1/traces")!.payloads[0]!.resourceSpans[0]!.resource.attributes;
    expect(read(lmResource, "service.name")).toBe("adapter-test");
` + s.slice(end);
  s = s.replace('      "laminar-test",', '      "Bearer laminar-test",');
  s = s.replace(/    expect\(received\.get\("\/laminar\/v1\/traces"\)!\.headers\["laminar-space-id"\]\)\.toBe\([\s\S]*?\n    \);\n/, "");
  s = s.replace('    "ARIZE_API_KEY",\n    "ARIZE_SPACE_ID",\n    "ARIZE_PROJECT_NAME",', '    "LMNR_PROJECT_API_KEY",');
  s = s.replaceAll('"openinference."', '"lmnr."').replaceAll('"openinference.project.name"', '"lmnr.association.properties.metadata.project"');
  return s;
});
await edit("packages/opentelemetry/test/tools.test.ts", source => {
  let s = source.replaceAll("Arize", "Laminar").replaceAll("arize", "laminar");
  s = s.replace('super({ apiKey: "key", spaceId: "space", projectName: "test" });', 'super({ apiKey: "key" });');
  const start = s.indexOf("  const aiFirst =");
  const end = s.indexOf("  const tlFirst =", start);
  if (start < 0 || end < 0) throw Error("Tool test anchors missing");
  return s.slice(0, start) + `  const lmFirst = generations(laminar!)[0]!;
  const lmFinal = generations(laminar!).at(-1)!;
  expect(decode(lmFirst, "lmnr.span.output")[0].parts[1]).toEqual({
    type: "tool_call", id: "time-call", name: "get_current_time", arguments: {},
  });
  const lmInput = decode(lmFinal, "lmnr.span.input");
  expect(lmInput[2].parts[0]).toEqual({ type: "tool_call_response", id: "time-call", result: { date: "2026-10-23" } });
  expect(lmInput[4].parts[0]).toEqual({ type: "tool_call_response", id: "weather-call", result: { date: "2026-10-23", temperature: 30 } });
  const lmTool = laminar!.find(span => span.name === "get_weather")!;
  expect(lmTool.attributes["gen_ai.tool.description"]).toBe(weather.description);
  expect(decode(lmTool, "tessar.metadata.toolParameters")).toEqual(weather.jsonSchema);
  expect(decode(lmTool, "lmnr.span.output")).toEqual({ date: "2026-10-23", temperature: 30 });

` + s.slice(end);
});
for (const path of ["tests/integration/public-imports.test.ts", "README.md", "packages/opentelemetry/package.json"])
  await edit(path, s => s.replaceAll("Arize", "Laminar").replaceAll("arize", "laminar"));
