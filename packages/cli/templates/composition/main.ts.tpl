import { OpenAIChat } from "@tessar/openai";
import { createAssistantAgent } from "./agents/assistant.js";
import { createMainController } from "./controllers/main.js";

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL;
if (!apiKey || !model) throw new Error("Set OPENAI_API_KEY and OPENAI_MODEL in .env.");

const agent = createAssistantAgent(new OpenAIChat({ connectionId: "primary-openai", apiKey, model }));
{{setup}}
try {
  await controller.initialize();
{{execution}}
} finally {
{{cleanup}}
}
