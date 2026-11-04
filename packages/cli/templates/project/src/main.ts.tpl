import { OpenAIChat } from "@tessar/openai";
import { createAssistantAgent } from "./agents/assistant.js";

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL;
if (!apiKey || !model) throw new Error("Set OPENAI_API_KEY and OPENAI_MODEL in .env.");

const agent = createAssistantAgent(new OpenAIChat({ apiKey, model }));
const result = await agent.generate(process.argv.slice(2).join(" ") || "Say hello.");
for (const message of result.output) {
  for (const part of message.content) {
    if (part.type === "text") console.log(part.text);
  }
}
