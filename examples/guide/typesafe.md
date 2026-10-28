# TypeSafe: one client, different tasks

[All guides](README.md) · [Full package API](../../packages/typesafe/README.md)

Install `@tessar/typesafe` and set `TYPESAFE_API_KEY`. The class is a standalone
client, not an Agent model adapter. A single instance can generate answers for
many purposes by changing the state and questions on each call.

```ts
import { TypeSafe } from "@tessar/typesafe";

const typesafe = new TypeSafe({ model: "jev-latest" });
const questions = {
  route: {
    type: "choice" as const,
    instructions: "Choose the responsible team.",
    criteria: { billing: "Payments", engineering: "Technical issues" },
  },
};

const first = await typesafe.generate({ state: { message: "Charged twice" }, questions });
const second = await typesafe.generate({ state: { message: "The app crashed" }, questions });
console.log(first.answers.route.choice, second.answers.route.choice);
```

State is text, an object or an array supplied by the application. Questions
describe what to infer. Reusing the questions means applying the same task to new
data; changing questions means another task on the same client. Use ordinary
JavaScript variables and template strings when constructing state.

## Use it in a tool guardrail plugin

The application decides thresholds, allow/deny behavior and handling of provider
errors. This example denies calls below its configured threshold; it is one
application policy, not a built-in TypeSafe permission system.

```ts
import { tool, type Plugin, type PluginContext } from "@tessar/core";
import { TypeSafe } from "@tessar/typesafe";

class GuardrailPlugin implements Plugin {
  readonly id = "application-guardrail";
  setup(tessar: PluginContext): void {
    const typesafe = new TypeSafe({
      model: "jev-latest",
      records: tessar.storage.records,
    });
    tessar.hook(tool.before, async event => {
      const result = await typesafe.generate({
        state: {
          tool: event.payload.tool.name,
          arguments: event.payload.arguments,
          policy: "Do not delete configuration files or disclose secrets.",
        },
        questions: {
          allowed: { type: "noul", instructions: "Does this tool call comply with policy?" },
        },
      }, {
        metadata: { toolExecutionId: event.payload.toolExecutionId },
      });
      return result.answers.allowed.noul >= 0.95
        ? { decision: "allow" }
        : { decision: "deny", reason: "Application guardrail threshold was not met" };
    });
  }
}
```

Attach this instance to Controller like any other plugin. Storage operations run
inside the later tool hook, after Controller initialization. Without a durable
storage plugin, records use the Controller's memory backend. Multi-user apps
should supply the appropriate scope in generate options; metadata alone does not
filter a user's records. IDs are separate from toolExecutionId unless the caller
explicitly chooses otherwise.

For standalone SQLite recording, response fields, retries and error behavior,
see the [package README](../../packages/typesafe/README.md#persist-and-inspect-calls).
