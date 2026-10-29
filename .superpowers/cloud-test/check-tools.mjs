import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
const session = await readFile(new URL("./src/session.ts", import.meta.url), "utf8");
const start = session.indexOf("const timeTool = createTool({");
const end = session.indexOf("const agent = new Agent({", start);
assert.ok(start >= 0 && end > start);
const code = stripTypeScriptTypes([
  `import { createTool } from ${JSON.stringify(import.meta.resolve("@tessar/core/tool"))};`,
  `import { z } from ${JSON.stringify(import.meta.resolve("zod"))};`,
  session.slice(start, end),
  "export { timeTool, weatherTool };",
].join("\n"), { mode: "strip" });
const { timeTool, weatherTool } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const context = { signal: AbortSignal.timeout(20_000) };
const clock = await timeTool.execute(timeTool.schema.parse({}), context);
assert.equal(clock.role, "tool");
assert.equal(clock.content[0].type, "data");
const { date, timeZone } = clock.content[0].data;
assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
const weather = await weatherTool.execute(weatherTool.schema.parse({ latitude: 10.8231, longitude: 106.6297, date, timeZone }), context);
assert.equal(weather.role, "tool");
assert.equal(weather.content[0].type, "data");
const result = weather.content[0].data;
assert.equal(result.daily.time[0], date);
console.log(JSON.stringify({ tools: [timeTool.name, weatherTool.name], date, timeZone, source: result.source,
  min: result.daily.temperature_2m_min[0], max: result.daily.temperature_2m_max[0],
  units: result.daily_units.temperature_2m_max,
}));
