import { createTool } from "@tessar/core/tool";
import { z } from "zod";

export const weather = createTool({
  name: "get_weather",
  description: "Get current weather at geographic coordinates using Open-Meteo.",
  schema: z.object({
    latitude: z.number().min(-90).max(90).describe("Latitude in decimal degrees"),
    longitude: z.number().min(-180).max(180).describe("Longitude in decimal degrees"),
  }),
  execute: async ({ latitude, longitude }, context) => {
    context.emit({ stage: "fetching_weather", latitude, longitude });

    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,wind_speed_10m",
      timezone: "auto",
    }).toString();

    const response = await fetch(url, {
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) {
      throw new Error(`Open-Meteo HTTP ${response.status}: ${await response.text()}`);
    }

    return await response.json();
  },
});
