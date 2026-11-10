import { Agent, type ModelSelection } from "@tessar/core";

export function create{{className}}Agent(model: ModelSelection): Agent {
  return new Agent({ id: "{{name}}", model, instructions: "You are a helpful assistant." });
}
