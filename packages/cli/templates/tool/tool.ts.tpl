import { createTool } from "@tessar/core/tool";
import { z } from "zod";

export const {{variableName}}Tool = createTool({
  name: "{{name}}",
  description: "TODO: Describe this tool.",
  schema: z.object({ input: z.string() }),
  execute: ({ input }) => {
    // TODO: Implement the tool using the validated input.
    return { input };
  },
});
