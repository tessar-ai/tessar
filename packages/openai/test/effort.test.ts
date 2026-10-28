import { expect, it } from "vitest";
import { OpenAIProvider } from "../src/provider.js";
it("maps effort per protocol without discarding other native settings", () => {
  const responses = new OpenAIProvider({ apiKey: "fixture", model: "fixture" });
  const chat = new OpenAIProvider({
    apiKey: "fixture",
    model: "fixture",
    api: "chat-completions",
  });
  expect(
    responses.effortOptions("high", {
      temperature: 0.2,
      reasoning: { summary: "auto" },
    }),
  ).toEqual({
    temperature: 0.2,
    reasoning: { summary: "auto", effort: "high" },
  });
  expect(chat.effortOptions("low", { temperature: 0.3 })).toEqual({
    temperature: 0.3,
    reasoning_effort: "low",
  });
  expect(() => responses.effortOptions("imaginary", {})).toThrow();
});
